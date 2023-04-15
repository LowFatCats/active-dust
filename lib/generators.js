const utils = require('@lowfatcats/moment-utils');
const _ = require('lodash');
const { dateToTS } = require('@lowfatcats/moment-utils/lib/utils');

const Generators = {};

// Creates an array of dates.
// Returns a promise.
//
// Options accepted:
// - startDate: a starting date (inclusive); default=now
// - endDate: an ending date (inclusive); default=now
//
// The order of start and end dates determines if the generated dates
// will be returned in increasing or decreasing order.
//
// E.g. type=months, startDate=2019-12, endDate=2020-01
//
// =>
//
// [
//   {
//     "date": "2019",
//     "type": "year"
//   },
//   {
//     "date": "December 2019",
//     "ref": "2019-12",
//     "type": "month"
//   },
//   {
//     "date": "2020",
//     "type": "year",
//     "current": true
//   },
//   {
//     "date": "January 2020",
//     "ref": "2020-01",
//     "type": "month"
//   }
// ]
//
Generators.timeline = async function timeline(type, options) {
  console.log(`Started timeline: ${type}`);

  const opts = {
    startDate: 'now',
    endDate: 'now',
    shortMonth: false,
    ...options,
  };

  const unit = (type || '').toLowerCase();
  const startDate = utils.convertDate(opts.startDate);
  const endDate = utils.convertDate(opts.endDate, startDate);

  console.log(`Decoded startDate: ${startDate ? startDate.format() : startDate}`);
  console.log(`Decoded endDate: ${endDate ? endDate.format() : endDate}`);

  if (!startDate || !endDate) {
    return [];
  }

  let dates = [];

  if (unit === 'year' || unit === 'years') {
    dates = utils.getTimeline(startDate, endDate, { year: true, month: false });
  } else if (unit === 'month' || unit === 'months') {
    dates = utils.getTimeline(startDate, endDate, {
      year: true,
      month: true,
      shortMonth: opts.shortMonth,
    });
  } else {
    throw new Error(`Unknown timeline type: ${type}`);
  }

  return dates;
};

module.exports = Generators;
