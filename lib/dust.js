/* jshint esversion: 6 */
/* jslint node: true */
/* eslint no-underscore-dangle: ["error", { "allow": ["_data", "_query",
                                                      "_process", "_default"] }] */

const dust = require('@lowfatcats/dustjs-helpers');
const qp = require('./queryProcessor');
const _ = require('lodash');

// Dust wrapper class that can prepare dynamic contexts
class Dust {
  // viewsPath: e.g. './views'
  // contextPath: e.g. './context'
  constructor(viewsPath = './views', contextPath = './context') {
    console.log(`Configure Dust views path: ${viewsPath}`);
    console.log(`Configure Dust context path: ${contextPath}`);
    this.viewsPath = viewsPath;
    this.contextPath = contextPath;
    this.dustjs = dust;
    this.render = this.dustjs.render.bind(this.dustjs);
    this.configure();
    this.dustFieldPrefix = '_dust_';
    this.dustFieldPrefixCompiled = '_dustc_';
    this.extractTemplateNameRegex = /dust\.register\("(.+?)"/;
  }

  configure() {
    // tell dust how to load templates
    this.dustjs.onLoad = function (templateName, options, callback) {
      const tmpl = `${this.viewsPath}/${templateName}.js`;
      console.log(`Loading template: ${tmpl}`);
      require(tmpl)(dust); // eslint-disable-line import/no-dynamic-require, global-require
      callback();
    }.bind(this);
  }

  // Walks through the fields in the input object and
  // resolves queries using the CMS.
  // E.g.    {'cats': {'_query': '{cms}/get/featured--cats'}}
  // becomes {'cats': ['cat1', 'cat2']}
  //
  // If a _query field is not found but _data exists,
  // then promotes _data fields to their parents.
  // E.g.    {'cats': {'_data': ['cat1', 'cat2']}}
  // becomes {'cats': ['cat1', 'cat2']}
  //
  // Returns a promise to resolve queries
  resolveQueries(object, extra) {
    if (Object.prototype.toString.call(object) === '[object Object]') {
      // We resolve only Objects
      if (Object.prototype.hasOwnProperty.call(object, '_query')) {
        // Resolve using dynamic query
        return new Promise((resolve /* , reject */) => {
          qp.executeQuery(object._query, extra)
            .then(result => {
              console.log(`Query result for ${object._query}:`, JSON.stringify(result, null, 2));
              if ('Item' in result) {
                if ('Data' in result.Item) {
                  return result.Item.Data;
                }
                return result.Item;
              } else if ('Items' in result) {
                return result.Items.map(x => ('Data' in x ? x.Data : x));
              } else {
                // just return the result as is
                return result;
              }
            })
            .then(result => {
              if (Object.prototype.hasOwnProperty.call(object, '_process')) {
                const postProcess = _.isArray(object._process)
                  ? object._process
                  : [object._process];
                for (const action of postProcess) {
                  result = qp.processResult(result, action);
                }
              }
              return result;
            })
            .then(value => {
              console.log(`Final result for ${object._query}:`, JSON.stringify(value, null, 2));
              resolve(value);
            })
            .catch(err => {
              console.error(`Query failed for ${object._query}:`, err);
              if (Object.prototype.hasOwnProperty.call(object, '_default')) {
                console.error('Fallback to _default:', JSON.stringify(object._default, null, 2));
                resolve(object._default);
              } else {
                console.error('No _default found');
                resolve(null);
              }
            });
        });
      } else if (Object.prototype.hasOwnProperty.call(object, '_data')) {
        // If no dynamic query, then resolve statically
        return Promise.resolve(object._data);
      }
      // process all children
      const childrenKeys = [];
      const childrenPromises = [];
      Object.keys(object).forEach(key => {
        childrenKeys.push(key);
        childrenPromises.push(this.resolveQueries(object[key], extra));
      });
      return Promise.all(childrenPromises).then(resolvedValues =>
        _.zipObject(childrenKeys, resolvedValues)
      );
    }
    // array or other type of object
    return Promise.resolve(object);
  }

  // Extracts the name of a template from a compiled Dust template
  //
  // E.g. '(function(dust){dust.register("tmpl",body_0)...' => tmpl
  extractTemplateName(compiledTemplate) {
    const match = this.extractTemplateNameRegex.exec(compiledTemplate);
    if (match) {
      return match[1];
    }
  }

  // Generates a random name for a Dust template
  //
  // E.g. body_1600546426902_8166618775236278
  randomTemplateName(base) {
    return base + '_' + Date.now() + '_' + (Math.random() + '').substring(2);
  }

  // Renders all dust-like fields from the context.
  //
  // The input context is updated in place.
  renderContextDust(context) {
    return this.renderFieldDust(context, context).then(() => {
      return context;
    });
  }

  // Walks through the fields in the input object and renders using Dust
  // all fields that start with _dust_ (e.g. _dust_content) or _dustc_
  // (e.g. _dustc_content).
  //
  // E.g.    {"article": {"_dust_content": "{@year/}"}}
  // becomes {"article": {"content": "2020"}}
  //
  // E.g.    {"article": {"_dustc_content": "(function(dust){...})"}}
  // becomes {"article": {"content": "2020"}}
  //
  // The input object is updated in place and reference to it is returned.
  renderFieldDust(context, object) {
    const objectType = Object.prototype.toString.call(object);
    const promises = [];
    if (objectType === '[object Object]') {
      // We resolve only Objects
      for (const key in object) {
        const isDustCompiledField = key.startsWith(this.dustFieldPrefixCompiled);
        if (
          (isDustCompiledField || key.startsWith(this.dustFieldPrefix)) &&
          typeof object[key] === 'string'
        ) {
          const tmpl = isDustCompiledField
            ? key.substr(this.dustFieldPrefixCompiled.length)
            : key.substr(this.dustFieldPrefix.length);
          const dustTmpl = isDustCompiledField
            ? this.extractTemplateName(object[key])
            : this.randomTemplateName(tmpl);
          if (isDustCompiledField) {
            // dust template already compiled
            if (!this.dustjs.cache[dustTmpl]) {
              this.dustjs.loadSource(object[key]);
            }
          } else {
            this.dustjs.loadSource(this.dustjs.compile(object[key], dustTmpl));
          }
          const promise = new Promise((resolve, reject) => {
            this.dustjs.render(dustTmpl, context, (err, out) => {
              if (err) {
                reject(err);
              } else {
                console.log('Dust context render ready:', tmpl, dustTmpl);
                delete object[key];
                object[tmpl] = out;
                if (!isDustCompiledField) {
                  // unload the temporary used template
                  delete this.dustjs.cache[dustTmpl];
                }
                resolve();
              }
            });
          });
          promises.push(promise);
        } else if (typeof object[key] === 'object') {
          promises.push(this.renderFieldDust(context, object[key]));
        }
      }
    } else if (objectType === '[object Array]') {
      // Walk down the arrays to render inside them as well
      for (const child of object) {
        if (typeof child === 'object') {
          promises.push(this.renderFieldDust(context, child));
        }
      }
    }
    return Promise.all(promises).then(() => {
      return object;
    });
  }

  // Prepares a DustJS page context
  // tmpl: the template name to load
  // options: additional options
  //   staticUrl must contain a full URL, without including a / at the end; empty and . are acceptable
  //   baseUrl must contain a full URL, without including a / at the end; empty and . are acceptable
  //   basePHPUrl must contain a full URL, without including a / at the end; empty and . are acceptable
  //   query: map of parameters extracted from the request.
  //          it can include params extracted from query, path or post body.
  //   renderDustContext: if true then certain context fields could be rendered in place
  prepareContext(tmpl, options) {
    const opts = {
      staticUrl: '',
      baseUrl: '',
      basePHPUrl: '',
      query: null,
      renderDustContext: false,
      ...options,
    };
    return new Promise((resolve, reject) => {
      console.log(`Start prepare context for: ${tmpl}`);
      const ctx = {};
      ctx.STATIC = opts.staticUrl;
      ctx.BASE = opts.baseUrl;
      ctx.PHP = opts.basePHPUrl;
      ctx.query = opts.query;
      /* eslint-disable import/no-dynamic-require, global-require */
      ctx.global = require(`${this.contextPath}/global.json`);
      ctx.page = require(`${this.contextPath}/pages/${tmpl}.json`);
      /* eslint-enable import/no-dynamic-require, global-require */
      const resolveGlobal = this.resolveQueries(ctx.global, opts.query);
      const resolvePage = this.resolveQueries(ctx.page, opts.query);
      Promise.all([resolveGlobal, resolvePage])
        .then(([resultGlobal, resultPage]) => {
          ctx.global = resultGlobal;
          ctx.page = resultPage;
          if (opts.renderDustContext === true) {
            return this.renderContextDust(ctx);
          }
          return ctx;
        })
        .then(ctx => {
          console.log(`Context ready for: ${tmpl}`);
          resolve(ctx);
        })
        .catch(err => {
          reject(err);
        });
    });
  }
}

module.exports = Dust;
