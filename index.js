require('dotenv').config();

const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');
const { google } = require('googleapis');
const calendar = google.calendar('v3');
const chrono = require('chrono-node');
const moment = require('moment');
const { pRateLimit } = require('p-ratelimit');

const rateLimit = pRateLimit({
  interval: 1000,
  rate: 1,
  concurrency: 1,
});

function lookup() {
  return axios.post(
    process.env.ENDPOINT,
    qs.stringify({ uprn: process.env.UPRN })
  );
}

function parseDate(date) {
  return moment(chrono.parseDate(date)).startOf('day');
}

function parse(res) {
  const $ = cheerio.load(res.data);
  const refuse = $('dd').eq(0).text().trim();
  const recycling = $('dd').eq(1).text().trim();
  const garden = $('dd')
    .eq(2)
    .text()
    .trim()
    .replace(/\s*\*$/, '');

  const todo = [];

  if (refuse) todo.push({ type: 'Refuse', date: parseDate(refuse) });
  if (recycling) todo.push({ type: 'Recycling', date: parseDate(recycling) });
  if (garden && garden.indexOf('N/A') === -1) todo.push({ type: 'Garden', date: parseDate(garden) });

  return todo;
}

function authenticate() {
  const googleAuth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/gm, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });

  google.options({
    auth: googleAuth,
  });
}

function getUpcomingEvents() {
  return calendar.events
    .list({
      calendarId: process.env.CALENDAR_ID,
      timeMin: new Date().toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    })
    .then((res) => {
      const events = res.data.items;
      const binEvents = [];
      if (events.length) {
        events.map((event, i) => {
          const match = event.summary.match(/^Bin Day \- (.*?)$/);
          if (match) {
            binEvents.push({
              date: moment(event.start.date),
              title: event.summary,
              type: match[1],
            });
          }
        });
      }
      return binEvents;
    });
}

function createEvent(event) {
  console.log(
    `creating event: Bin Day - ${event.type}: ${event.date.format(
      'yyyy-MM-DD'
    )}`
  );
  var event = {
    summary: `Bin Day - ${event.type}`,
    start: { date: event.date.format('yyyy-MM-DD') },
    end: { date: event.date.add(1, 'day').format('yyyy-MM-DD') },
    transparency: 'transparent',
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 60 * 24 }],
    },
  };

  return calendar.events.insert({
    calendarId: process.env.CALENDAR_ID,
    resource: event,
  });
}

function filterExisting(upcoming) {
  return getUpcomingEvents().then((existing) => {
    return upcoming.filter((upcomingEvent) => {
      return !existing.find((existingEvent) => {
        return existingEvent.date.isSame(upcomingEvent.date);
      });
    });
  });
}

function createEvents(events) {
  return Promise.all(
    events.map((event) => rateLimit(() => createEvent(event)))
  );
}

authenticate();

lookup().then(parse).then(filterExisting).then(createEvents);
