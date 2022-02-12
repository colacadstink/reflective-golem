import 'cross-fetch/polyfill';
import * as csv from 'fast-csv';
import * as dialog from 'node-file-dialog';
import * as prompts from 'prompts';
import {Event, EventlinkClient, Organization} from 'spirit-link';

const CSV_MAPPINGS = {
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email'
}
type PlayerData = {email: string, firstName: string, lastName: string};

function convertCsvToPlayerData(row: any): PlayerData {
  return {
    firstName: row[CSV_MAPPINGS.firstName],
    lastName: row[CSV_MAPPINGS.lastName],
    email: row[CSV_MAPPINGS.email],
  }
}

let eventlink: EventlinkClient;

(async () => {
  let loginInfo = {
    username: process.env.EVENTLINK_USERNAME,
    password: process.env.EVENTLINK_PASSWORD
  }
  if(!loginInfo.username || !loginInfo.password) {
    loginInfo = await prompts([{
      type: 'text',
      message: 'EventLink email address:',
      name: 'username'
    }, {
      type: 'password',
      message: 'EventLink password:',
      name: 'password'
    }]);
  } else {
    console.log('Using login info from env');
  }

  eventlink = new EventlinkClient();
  await eventlink.login(loginInfo.username, loginInfo.password);

  const me = await eventlink.getMe();
  let org: Organization;
  if(me.roles.length === 0) {
    console.error('No roles found for this user!');
    return;
  } else if(me.roles.length === 1) {
    org = me.roles[0].organization;
    console.log(`Using "${org.name}"`);
  } else {
    org = (await prompts({
      type: 'select',
      message: 'Organization:',
      name: 'org',
      choices: me.roles.map((role) => {
        return {
          title: role.organization.name,
          value: role.organization
        };
      }),
    })).org as Organization;
  }

  const events = await eventlink.getUpcomingEvents(org.id);
  const event = (await prompts({
    type: 'select',
    name: 'event',
    message: 'Event to add users to:',
    choices: events.events.map((event) => {
      return {
        title: `${event.title} (${new Date(event.scheduledStartTime).toLocaleDateString()})`,
        value: event
      };
    })
  })).event as Event;

  const existingPlayers = await eventlink.getPlayersInEvent(event.id);

  console.log('Prompting for player CSV...');
  let csvFile = (await dialog({type: 'open-file'}))[0];

  console.log('Prompting for where to save the missing players...');
  let outFile = (await dialog({type: 'save-file'}))[0];

  const rows = [];
  csv.parseFile(csvFile, { headers: true })
    .on('data', (rawRow) => {
      const row = convertCsvToPlayerData(rawRow);
      if(row.firstName && row.lastName) {
        if(existingPlayers.some((reg) => reg.firstName === row.firstName && reg.lastName === row.lastName)) {
          if(row.email) {
            console.warn(`WARNING: There is already a player in this event with the name "${row.firstName} ${row.lastName}". They may have already been added - if the email address ${row.email} is in the error file, you may want to ignore it.`);
          } else {
            console.warn(`WARNING: There is already a player in this event with the name "${row.firstName} ${row.lastName}". They did not provide an email address. They will be skipped.`)
            return;
          }
        }
        rows.push(row);
      } else {
        console.error('User data missing from row - maybe the CSV_MAPPINGS are set wrong?');
        console.error(rawRow);
        process.exit(1);
      }
    })
  .on('end', async () => {
    const missingPlayers = await addPlayers(event.id, rows);

    csv.writeToPath(outFile, missingPlayers, {headers: true})
      .on('error', (err) => {
        console.error(err);
        process.exit(1);
      })
      .on('finish', () => {
        console.log('Done!');
        process.exit(0);
      });
  });
})();

function addPlayers(eventId: string, players: PlayerData[]) {
  const missingPlayers: PlayerData[] = [];

  return new Promise<PlayerData[]>((resolve) => {
    let i = -1; // will get incremented to 0 on first loop
    const addNextPlayer = () => {
      i++;
      if(i >= players.length) {
        resolve(missingPlayers);
      } else {
        console.log('-----');
        if(!players[i].email) {
          console.log(`Adding guest player ${players[i].firstName} ${players[i].lastName}`);
          addGuest(eventId, players[i], missingPlayers).then(() => addNextPlayer());
        } else {
          console.log(`Adding player ${players[i].firstName} ${players[i].lastName} (${players[i].email})`);
          eventlink.registerPlayerByEmail(eventId, players[i].email).then((result) => {
            if(!result.success) {
              const errMsg: string | undefined = result.err.message;
              if(errMsg) {
                if(errMsg.includes('Player already registered')) {
                  console.log('Player already registered. Skipping.');
                  addNextPlayer();
                  return;
                } else if(errMsg.includes('No platform account found')) {
                  console.log('Player does not have an account with that email address. Adding as guest.');
                  addGuest(eventId, players[i], missingPlayers).then(() => addNextPlayer());
                  return;
                } else {
                  console.log(errMsg);
                }
              }
              console.log('Unable to add player. Logging.');
              missingPlayers.push(players[i]);
              addNextPlayer();
            }
          });
        }
      }
    };

    eventlink.subscribeToPlayerRegistered(eventId).subscribe(async (player) => {
      if(!player.firstName || !player.lastName) {
        console.log('No name set by player; adding name');
        await eventlink.setRegisteredPlayerName({
          eventId,
          id: player.id,
          firstName: players[i].firstName,
          lastName: players[i].lastName
        });
      }
      console.log('Player added.');
      addNextPlayer();
    }, (err) => {
      console.error(err);
    });

    addNextPlayer();
  });
}

async function addGuest(eventId: string, player: PlayerData, missingPlayers: PlayerData[]) {
  const result = await eventlink.registerGuestPlayer(eventId, player.firstName, player.lastName);
  if(!result.success) {
    console.error(`Unable to add guest player for some reason - ${player.firstName} ${player.lastName}`);
    missingPlayers.push(player);
  }
}
