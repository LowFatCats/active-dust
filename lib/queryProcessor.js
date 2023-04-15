/* jshint esversion: 6 */
/* jslint node: true */

const qp = {};

const cms = require('@lowfatcats/datastore-dynamodb');
const gen = require('./generators');
const utils = require('@lowfatcats/moment-utils');
const _ = require('lodash');

/**
 * Parses URL-like queries
 *
 * E.g. {module}/<action>/<target>?param1=value1&param2=value2...
 */
class Query {
  constructor(query) {
    this.regex = /^\{(\w+)\}\/(\w+)(?:\/([^/?]+))?\??(.*)$/;
    this.parseQuery(query);
  }

  init() {
    this.module = undefined;
    this.action = undefined;
    this.target = undefined;
    this.params = {};
    this.isValid = true;
  }

  parseQuery(query) {
    this.init();
    if (!query) {
      this.isValid = false;
      return;
    }
    const found = query.match(this.regex);
    if (found) {
      [, this.module, this.action, this.target] = found;
      this.params = Query.splitParams(found[4]);
    } else {
      this.isValid = false;
    }
  }

  static splitParams(paramsString) {
    const params = {};
    if (!paramsString) {
      return params;
    }
    paramsString.split('&').forEach(keyValue => {
      // keyValue is of form 'key=value' or 'key'
      const sep = keyValue.indexOf('=');
      if (sep < 0) {
        // If no equal sign found then keep only the key
        params[keyValue.trim()] = undefined;
      } else {
        params[keyValue.slice(0, sep).trim()] = keyValue.slice(sep + 1).trim();
      }
    });
    return params;
  }
}

/**
 * Interprets and executes a query.
 * extra: (optional) provides additional named parameters for query.
 * Returns the promise of a result.
 */
qp.executeQuery = function (queryString, extra) {
  console.log(`Execute query: ${queryString} extra: ${JSON.stringify(extra)}`);
  const query = new Query(queryString);
  if (!query.isValid) {
    return Promise.reject(new Error(`Cannot parse: ${query}`));
  }
  // combine the provided extra parameters with the ones extracted from the query.
  const overrides = {};
  if (extra && query.params) {
    // Allow to define a max limit in query, that can be overriden with a smaller value in extra
    if (extra.limit && query.params.limit) {
      overrides.limit = Math.min(parseInt(extra.limit, 10), parseInt(query.params.limit, 10));
    }
  }
  query.params = Object.assign({}, extra, query.params, overrides);
  query.target = query.target || query.params.target;
  console.log(
    `Decoded query: module=${query.module}, action=${query.action}, target=${
      query.target
    }, params=${JSON.stringify(query.params)}`
  );
  if (query.module === 'cms') {
    switch (query.action) {
      case 'get':
        if (query.target) {
          return cms.get(query.target, query.params);
        }
        return Promise.reject(new Error(`Query action ${query.action} requires a target id`));

      case 'list':
        if (query.target) {
          return cms.queryByTypeTS(query.target, query.params);
        }
        return Promise.reject(new Error(`Query action ${query.action} requires a target type`));

      case 'featured':
        if (query.target) {
          return cms.queryByTypeFeatured(query.target, query.params);
        }
        return Promise.reject(new Error(`Query action ${query.action} requires a target type`));

      case 'highlight':
        if (query.target) {
          return cms.getList(query.target, query.params);
        }
        return Promise.reject(new Error(`Query action ${query.action} requires a target type`));

      case 'random':
        if (query.target) {
          return cms.getRandomList(query.target, query.params);
        }
        return Promise.reject(new Error(`Query action ${query.action} requires a target type`));

      default:
        return Promise.reject(new Error(`Unknown query action: ${query.action}`));
    }
  } else if (query.module === 'gen') {
    switch (query.action) {
      case 'timeline':
        if (query.target) {
          return gen.timeline(query.target, query.params);
        }
        return Promise.reject(new Error(`Query action ${query.action} requires a target type`));

      default:
        return Promise.reject(new Error(`Unknown query action: ${query.action}`));
    }
  } else {
    return Promise.reject(new Error(`Unknown query module: ${query.module}`));
  }
};

/**
 * Applies some post-processing on a result.
 *
 * processType can be a string (e.g. "TimeAgo") or an object with
 * "action" and additional argument fields (e.g. {"action": "Limit", "limit": 5})
 *
 */
qp.processResult = function (result, processType) {
  console.log('Process result:', processType);

  const action = processType && processType.action ? processType.action : processType;
  const params = processType && processType.action ? processType : {};

  switch (action) {
    case 'CalendarEvents':
      return qp.processCalendarEvents(result);

    case 'TimeAgo':
      return qp.processTimeAgo(result);

    case 'TimeAgoInDays':
      return qp.processTimeAgoInDays(result, params);

    case 'DisplayDate':
      return qp.processDisplayDate(result, params);

    case 'ArticleDate':
      return qp.processArticleDate(result, params);

    case 'GroupByDate':
      return qp.groupByDate(result);

    case 'AddYearMonthHeadings':
      return qp.addYearMonthHeadings(result, params);

    case 'Limit':
      return qp.limit(result, params);

    case 'RemoveDuplicates':
      return qp.removeDuplicates(result, params);

    case 'RemoveDuplicatesFromGroups':
      return qp.removeDuplicatesFromGroups(result, params);

    case 'Sort':
      return qp.sort(result, params);

    case 'SortEachGroup':
      return qp.sortEachGroup(result, params);

    case 'Project':
      return qp.projectFields(result, params);

    case 'FirstItem':
      return qp.firstItem(result, params);

    case 'NormalizeImages':
      return qp.normalizeImages(result, params);

    default:
      throw new Error(`Unknown process type: ${processType}`);
  }
};

/**
 * Processes a list of events and converts date -> month, day, time
 * such that a minimum level of information is kept.
 *
 * The sequence of events is important.
 *
 * E.g. [
 *        {"date": "2017-10-03T16:00:00.000Z"},
 *        {"TS": 1507068000000}
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "date": "2017-10-03T16:00:00.000Z",
 *          "month": "October",
 *          "day": "03",
 *          "time": "11:00 AM"
 *        },
 *        {
 *          "TS": 1507068000000,
 *          "time": "5:00 PM"
 *        }
 *      ]
 *
 *  Note that the month, day and time are represented in the
 *  "local" timezone (US/Central).
 */
qp.processCalendarEvents = function (events) {
  let prevYear;
  let prevMonth;
  let prevDay;
  events.forEach(item => {
    const updated = item;
    let dmt = null;
    if ('date' in item) {
      dmt = utils.getYearMonthDayTime(item.date);
    } else if ('TS' in item) {
      dmt = utils.getYearMonthDayTime(item.TS);
    }
    if (dmt) {
      // keep only the values that changed when moving from event to event
      if (prevYear === undefined || prevYear !== dmt[0]) {
        [updated.year] = dmt;
      }
      if (prevMonth === undefined || prevMonth !== dmt[1]) {
        [, updated.month] = dmt;
      }
      if (prevDay === undefined || prevDay !== dmt[2]) {
        [, , updated.day] = dmt;
      }
      [, , , updated.time] = dmt;

      [prevYear, prevMonth, prevDay] = dmt;
    }
  });
  return events;
};

/**
 * Processes a list of events and converts date -> time ago
 * and group together the events that have the same "time ago".
 *
 * The sequence of events is important.
 *
 * E.g. [
 *        {"TS": 1503072614411},
 *        {"TS": 1503072614410},
 *        {"TS": 1502727027332}
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "TS": 1503072614411,
 *          "date": "2 days ago"
 *        },
 *        {
 *          "TS": 1503072614410
 *        },
 *        {
 *          "TS": 1502727027332,
 *          "date": "6 days ago"
 *        }
 *      ]
 */
qp.processTimeAgo = function (events) {
  let prevTimeAgo;
  events.forEach(item => {
    const updated = item;
    let timeAgo = null;
    if ('TS' in item) {
      timeAgo = utils.getTimeAgo(item.TS);
    }
    if (timeAgo) {
      // keep only the dates that changed when moving from event to event
      if (prevTimeAgo === undefined || prevTimeAgo !== timeAgo) {
        updated.date = timeAgo;
      }
      prevTimeAgo = timeAgo;
    }
  });
  return events;
};

/**
 * Processes a list of events and converts date -> time ago
 * and group together the events that have the same "time ago".
 *
 * The sequence of events is important.
 *
 * E.g. [
 *        {"TS": 1503072614411},
 *        {"TS": 1503072614410},
 *        {"TS": 1502727027332}
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "TS": 1503072614411,
 *          "date": "Today"
 *        },
 *        {
 *          "TS": 1503072614410
 *        },
 *        {
 *          "TS": 1502727027332,
 *          "date": "6 days ago"
 *        }
 *      ]
 */
qp.processTimeAgoInDays = function (events, options) {
  const opts = {
    hoursOffset: 0,
    ...options,
  };
  let prevTimeAgo;
  events.forEach(item => {
    const updated = item;
    let timeAgo = null;
    if ('TS' in item) {
      timeAgo = utils.getTimeAgoInDays(item.TS, opts);
    }
    if (timeAgo) {
      // keep only the dates that changed when moving from event to event
      if (prevTimeAgo === undefined || prevTimeAgo !== timeAgo) {
        updated.date = timeAgo;
      }
      prevTimeAgo = timeAgo;
    }
  });
  return events;
};

/**
 * Processes a list of events and converts date to a formatted date,
 * and group together the events that have the same "time ago".
 *
 * The sequence of events is important.
 *
 * E.g. [
 *        {"TS": 1503072614411},
 *        {"TS": 1503072614410},
 *        {"TS": 1502727027332}
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "TS": 1503072614411,
 *          "date": "Today"
 *        },
 *        {
 *          "TS": 1503072614410
 *        },
 *        {
 *          "TS": 1502727027332,
 *          "date": "June 29"
 *        }
 *      ]
 */
qp.processDisplayDate = function (events, options) {
  const opts = {
    relativeDays: 2,
    hoursOffset: 0,
    year: 'default', // default, always, never
    shortMonth: false,
    ...options,
  };
  let prevTimeAgo;
  events.forEach(item => {
    const updated = item;
    let timeAgo = null;
    if ('TS' in item) {
      timeAgo = utils.getDisplayDate(item.TS, opts);
    }
    if (timeAgo) {
      // keep only the dates that changed when moving from event to event
      if (prevTimeAgo === undefined || prevTimeAgo !== timeAgo) {
        updated.date = timeAgo;
      }
      prevTimeAgo = timeAgo;
    }
  });
  return events;
};

/**
 * Processes one or multiple items and converts dates to a formatted values.
 *
 * E.g. {"publishUp": "2020-08-01T12:00:00.000Z"}
 *
 * will be converted to:
 *
 *      {
 *        "publishUp": "2020-08-01T12:00:00.000Z",
 *        "shortDate": "Aug 1",
 *        "fullDate": "Saturday, August 1, 2020"
 *      }
 *
 * -or-
 *
 *      [
 *        {"TS": 1503072614411},
 *        {"publishUp": "2020-08-01T12:00:00.000Z"},
 *        {"TS": 1502727027332}
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "TS": 1503072614411,
 *          "shortDate": "Aug 18",
 *          "fullDate": "Friday, August 18, 2017"
 *        },
 *        {
 *          "publishUp": "2020-08-01T12:00:00.000Z",
 *          "shortDate": "Aug 1",
 *          "fullDate": "Saturday, August 1, 2020"
 *        },
 *        {
 *          "TS": 1502727027332,
 *          "shortDate": "Aug 14",
 *          "fullDate": "Monday, August 14, 2017"
 *        }
 *      ]
 */
qp.processArticleDate = function (items, options) {
  const opts = {
    input: ['date', 'publishUp', 'TS'],
    shortDateField: 'shortDate',
    fullDateField: 'fullDate',
    ...options,
  };
  if (!opts.input) {
    opts.input = [];
  } else if (_.isString(opts.input)) {
    opts.input = [opts.input];
  }
  const toProcess = _.isArray(items) ? items : [items];
  const processed = toProcess.map(item => {
    for (const field of opts.input || []) {
      if (field in item) {
        const short = utils.getFormattedDate(item[field], { year: 'never', shortMonth: true });
        const full = utils.getFormattedDate(item[field], { year: 'always', dayOfTheWeek: true });
        item[opts.shortDateField] = short;
        item[opts.fullDateField] = full;
        break;
      }
    }
    return item;
  });
  return _.isArray(items) ? processed : processed[0];
};

/**
 * Groups a list of events under the same date.
 *
 * The sequence of events is important.
 *
 * E.g. [
 *        {
 *          "TS": 1503072614411,
 *          "date": "Today"
 *        },
 *        {
 *          "TS": 1503072614410
 *        },
 *        {
 *          "TS": 1502727027332,
 *          "date": "6 days ago"
 *        }
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "date": "Today",
 *          "items": [
 *            {
 *             "TS": 1503072614411,
 *            },
 *           {
 *             "TS": 1503072614410
 *            }
 *          ]
 *        },
 *        {
 *          "date": "6 days ago",
 *          "items": [
 *            {
 *             "TS": 1502727027332
 *            }
 *          ]
 *        }
 *      ]
 */
qp.groupByDate = function (events) {
  const updated = [];
  let currentItem;
  for (const event of events) {
    if (event.date) {
      if (currentItem) {
        updated.push(currentItem);
      }
      currentItem = {
        date: event.date,
        items: [event],
      };
      delete event.date;
    } else {
      currentItem.items.push(event);
    }
  }
  if (currentItem) {
    updated.push(currentItem);
  }
  return updated;
};

/**
 * Limits a list of items to a specific size.
 *
 * E.g. if options are { size: 2 } then
 *      [
 *        {
 *          "TS": 1503072614411,
 *        },
 *        {
 *          "TS": 1503072614410
 *        },
 *        {
 *          "TS": 1502727027332,
 *        }
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "TS": 1503072614411,
 *        },
 *        {
 *          "TS": 1503072614410
 *        }
 *      ]
 */
qp.limit = function (items, options) {
  const opts = {
    size: 10,
    ...options,
  };
  return items.slice(0, opts.size);
};

/**
 * Removes duplicated items based on a certain dedupField.
 *
 * E.g. if options are
 *
 *      {
 *        dedupField: "name",
 *        priorityField: "type",
 *        priorityValues: ["new", "updated"]
 *      }
 *
 * then input
 *
 *      [
 *        {
 *         "TS": 1503072614411,
 *         "name": "John",
 *         "type": "updated"
 *        },
 *        {
 *         "TS": 1503072614410,
 *         "name": "John",
 *         "type": "new"
 *        }
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *         "TS": 1503072614410,
 *         "name": "John",
 *         "type": "new"
 *        }
 *      ]
 */
qp.removeDuplicates = function (items, options) {
  const opts = {
    dedupField: null,
    priorityField: null,
    priorityValues: [],
    ...options,
  };

  const updated = [];
  const keepValue = {};
  const keepPriority = {};

  // select which item should be kept
  for (const item of items) {
    const dedupValue = item[opts.dedupField];
    const candidateValue = item[opts.priorityField];
    const candidatePriority = opts.priorityValues.indexOf(candidateValue);

    const currentValue = keepValue[dedupValue];
    if (currentValue !== undefined) {
      const currentPriority = keepPriority[dedupValue];
      if (candidatePriority >= 0 && candidatePriority < currentPriority) {
        // lower index values have higher priority
        keepValue[dedupValue] = candidateValue;
        keepPriority[dedupValue] = candidatePriority;
      }
    } else {
      keepValue[dedupValue] = candidateValue;
      keepPriority[dedupValue] = candidatePriority >= 0 ? candidatePriority : 99999;
    }
  }

  // Use to ensure that only only item with target dedupField value if kept
  const used = new Set();

  // Performs the deduplication
  for (const item of items) {
    const dedupValue = item[opts.dedupField];
    const candidateValue = item[opts.priorityField];
    if (!used.has(dedupValue) && keepValue[dedupValue] === candidateValue) {
      used.add(dedupValue);
      updated.push(item);
    }
  }

  return updated;
};

/**
 * Removes duplicated items from groups.
 *
 * E.g. if options are
 *
 *      {
 *        dedupField: "name",
 *        priorityField: "type",
 *        priorityValues: ["new", "updated"]
 *      }
 *
 * then input
 *
 *      [
 *        {
 *          "date": "Today",
 *          "items": [
 *            {
 *             "TS": 1503072614411,
 *             "name": "John",
 *             "type": "updated"
 *            },
 *            {
 *             "TS": 1503072614410,
 *             "name": "John",
 *             "type": "new"
 *            }
 *          ]
 *        },
 *        {
 *          "date": "6 days ago",
 *          "items": [
 *            {
 *             "TS": 1502727027332
 *            }
 *          ]
 *        }
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "date": "Today",
 *          "items": [
 *            {
 *             "TS": 1503072614410,
 *             "name": "John",
 *             "type": "new"
 *            }
 *          ]
 *        },
 *        {
 *          "date": "6 days ago",
 *          "items": [
 *            {
 *             "TS": 1502727027332
 *            }
 *          ]
 *        }
 *      ]
 */
qp.removeDuplicatesFromGroups = function (groups, options) {
  const opts = {
    dedupField: null,
    priorityField: null,
    priorityValues: [],
    ...options,
  };

  const updated = [];

  for (const group of groups) {
    if (group.items && group.items.length > 0) {
      updated.push({
        ...group,
        items: qp.removeDuplicates(group.items, opts),
      });
    } else {
      updated.push(group);
    }
  }

  return updated;
};

/**
 * Sorts a list of items.
 *
 * E.g. if options are
 *
 *      {
 *        fields: ["name"],
 *        orders: ["asc"]
 *      }
 *
 * then input
 *
 *      [
 *        {
 *         "TS": 1503072614411,
 *         "name": "Beta"
 *        },
 *        {
 *         "TS": 1503072614410,
 *         "name": "Alpha"
 *        }
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *         "TS": 1503072614410,
 *         "name": "Alpha"
 *        },
 *        {
 *         "TS": 1503072614411,
 *         "name": "Beta"
 *        }
 *      ]
 */
qp.sort = function (items, options) {
  const opts = {
    fields: null,
    orders: null,
    ...options,
  };

  const updated = _.orderBy(items, opts.fields, opts.orders);
  return updated;
};

/**
 * Sort items in each group.
 *
 * E.g. if options are
 *
 *      {
 *        fields: ["name"],
 *        orders: ["asc"]
 *      }
 *
 * then input
 *
 *      [
 *        {
 *          "date": "Today",
 *          "items": [
 *            {
 *             "TS": 1503072614411,
 *             "name": "Beta"
 *            },
 *            {
 *             "TS": 1503072614410,
 *             "name": "Alpha"
 *            }
 *          ]
 *        },
 *        {
 *          "date": "6 days ago",
 *          "items": [
 *            {
 *             "TS": 1502727027332
 *            }
 *          ]
 *        }
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "date": "Today",
 *          "items": [
 *            {
 *             "TS": 1503072614410,
 *             "name": "Alpha"
 *            },
 *            {
 *             "TS": 1503072614411,
 *             "name": "Beta"
 *            }
 *          ]
 *        },
 *        {
 *          "date": "6 days ago",
 *          "items": [
 *            {
 *             "TS": 1502727027332
 *            }
 *          ]
 *        }
 *      ]
 */
qp.sortEachGroup = function (groups, options) {
  const opts = {
    fields: null,
    orders: null,
    ...options,
  };

  const updated = [];

  for (const group of groups) {
    if (group.items && group.items.length > 0) {
      updated.push({
        ...group,
        items: qp.sort(group.items, opts),
      });
    } else {
      updated.push(group);
    }
  }

  return updated;
};

/**
 * Adds year and month headings to a list of events.
 *
 * The sequence of events is important.
 *
 * E.g. [
 *        {
 *          "TS": 1503072614411,
 *          "date": "Today"
 *        },
 *        {
 *          "date": "6 days ago",
 *          "items": [
 *            {
 *             "TS": 1502727027332
 *            }
 *          ]
 *        },
 *        {
 *          "date": "1 month ago",
 *          "items": [
 *            {
 *             "TS": 1501727027332
 *            }
 *          ]
 *        }
 *      ]
 *
 * will be converted to:
 *
 *      [
 *        {
 *          "date": "2020",
 *          "ref": "2020",
 *          "type": "year",
 *          "current": true
 *        },
 *        {
 *          "date": "July",
 *          "ref": "2020-07",
 *          "type": "month",
 *          "current": true
 *        },
 *        {
 *          "TS": 1503072614411,
 *          "date": "Today"
 *        },
 *        {
 *          "date": "6 days ago",
 *          "items": [
 *            {
 *             "TS": 1502727027332
 *            }
 *          ]
 *        },
 *        {
 *          "date": "June",
 *          "ref": "2020-06",
 *          "type": "month"
 *        },
 *        {
 *          "date": "1 month ago",
 *          "items": [
 *            {
 *             "TS": 1501727027332
 *            }
 *          ]
 *        }
 *      ]
 */
qp.addYearMonthHeadings = function (events, options) {
  const opts = {
    hoursOffset: 0,
    showYearInMonth: true,
    ...options,
  };

  const showYearInMonth =
    opts.showYearInMonth === true ||
    opts.showYearInMonth === 'true' ||
    opts.showYearInMonth === '1';
  const current = utils.getYearMonthDay(Date.now(), opts);
  const updated = [];
  let year;
  let month;

  for (const event of events) {
    const ts = event.TS
      ? event.TS
      : event.items && event.items.length > 0
      ? event.items[0].TS
      : null;

    if (ts) {
      const date = utils.getYearMonthDay(ts, opts);
      if (date) {
        if (year !== date.year) {
          const entry = {
            date: date.year,
            ref: date.year,
            type: 'year',
          };
          if (date.year === current.year) {
            entry.current = true;
          }
          year = date.year;
          updated.push(entry);
        }
        if (month !== date.month) {
          const entry = {
            date: date.month + (showYearInMonth ? ' ' + date.year : ''),
            ref: `${date.year}-${date.monthNumber.length === 1 ? '0' : ''}${date.monthNumber}`,
            type: 'month',
          };
          if (date.year === current.year && date.month === current.month) {
            entry.current = true;
          }
          month = date.month;
          updated.push(entry);
        }
      }
    }

    // always keep the original events
    updated.push(event);
  }

  return updated;
};

/**
 * Processes one or multiple items and keeps only a list of fields.
 *
 * Simple or multi level dot properties (e.g. "name.first") are supported.
 *
 *
 * E.g. items = {"name": {"first": "Joe", "last": "Plum"}, "age": 30, "salary": 100000}
 *      fields = ["name.first", "age"]
 *
 * will be converted to:
 *
 *      {"name": {"first": "Joe"}, "age": 30}
 *
 * -or-
 *
 *      items = [{"name": {"first": "Joe", "last": "Plum"}, "age": 30, "salary": 100000}]
 *      fields = ["name"]
 *
 * will be converted to:
 *
 *      [{"name": {"first": "Joe", "last": "Plum"}}]
 *
 */
qp.projectFields = function (items, options) {
  const opts = {
    fields: [],
    removeEmpty: true,
    ...options,
  };
  if (!opts.fields) {
    opts.fields = [];
  }
  const toProcess = _.isArray(items) ? items : [items];
  let processed = _.map(toProcess, x => _.pick(x, opts.fields));
  if (opts.removeEmpty === true) {
    processed = _.filter(processed, x => !_.isEmpty(x));
  }

  return _.isArray(items) ? processed : processed.length ? processed[0] : {};
};

/**
 * Processes one or multiple items and returns only the first item.
 *
 * E.g. items = {"some": "object"}
 *
 * will return the same object (since it's not an array):
 *
 *      {"some": "object"}
 *
 * -or-
 *
 *      items = [{"id": 1}, {"id": 2}]
 *
 * will be converted to:
 *
 *      {"id": 1}
 *
 */
qp.firstItem = function (items, options) {
  const opts = {
    default: {},
    ...options,
  };
  if (_.isArray(items)) {
    return items[0] || opts.default;
  } else {
    return items || opts.default;
  }
};

/**
 * Checks if a certain object path is good candidate for image extraction.
 * If the urlPath and nodePath are valid, returns the object for nodePath or
 * a new object if nodePath is missing or null.
 *
 * @param {object} item the parent item
 * @param {string} urlPath the object path for the url to test
 * @param {string} nodePath node path to use or null to create new node
 */
function normalizeImagesCheckNode(item, urlPath, nodePath) {
  const url = _.get(item, urlPath);
  const node = nodePath ? _.get(item, nodePath) : {};

  if (url && typeof url === 'string' && typeof node === 'object') {
    const output = {
      url,
    };
    if (node.width) {
      output.width = node.width;
    }
    if (node.height) {
      output.height = node.height;
    }
    return output;
  }

  // this node is not good
  return null;
}

/**
 * Processes one or multiple items and compute some dynamic fields for images,
 * by creating a standard way where to locate the hero and thumb images.
 *
 * All updates are done in place, and the updated input object is being returned.
 *
 * E.g. items = {"image": "xyz"}
 *
 * will return the same object (since it's not an array):
 *
 *      {"image": "xyz", "heroImage": {"url": "xyz"}}
 *
 * -or-
 *
 *      items = [{"image": "xyz"}]
 *
 * will be converted to:
 *
 *      [{"image": "xyz", "heroImage": {"url": "xyz"}}]
 *
 */
qp.normalizeImages = function (items, options) {
  const opts = {
    fields: ['heroImage', 'heroLink', 'thumbImage'],
    ...options,
  };
  if (!opts.fields) {
    opts.fields = [];
  }
  const toProcess = _.isArray(items) ? items : [items];
  if (toProcess.length === 0) {
    return items;
  }

  let node;

  for (const item of toProcess) {
    for (const field of opts.fields) {
      switch (field) {
        case 'heroImage':
          if (!item.heroImage) {
            node =
              normalizeImagesCheckNode(item, 'image.url', 'image') ||
              normalizeImagesCheckNode(item, 'images.hero.full.url', 'images.hero.full') ||
              normalizeImagesCheckNode(item, 'images.hero.url', 'images.hero') ||
              normalizeImagesCheckNode(item, 'image');
            if (node) {
              item.heroImage = node;
            }
          }
          break;
        case 'heroLink':
          if (!item.heroLink) {
            node =
              normalizeImagesCheckNode(item, 'image.link', 'image') ||
              normalizeImagesCheckNode(item, 'images.hero.link', 'images.hero') ||
              normalizeImagesCheckNode(item, 'image-link');
            if (node) {
              item.heroLink = node.url;
            }
          }
          break;
        case 'thumbImage':
          if (!item.thumbImage) {
            node =
              normalizeImagesCheckNode(item, 'image.url', 'image') ||
              normalizeImagesCheckNode(item, 'images.hero.thumb.url', 'images.hero.thumb') ||
              normalizeImagesCheckNode(item, 'thumb') ||
              normalizeImagesCheckNode(item, 'image') ||
              normalizeImagesCheckNode(item, 'images.hero.url', 'images.hero') ||
              normalizeImagesCheckNode(item, 'images.hero.full.url', 'images.hero.full');
            if (node) {
              item.thumbImage = node;
            }
          }
          break;
        default:
      }
    }
  }

  return items;
};

module.exports = qp;
