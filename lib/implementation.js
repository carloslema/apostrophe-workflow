var _ = require('lodash');
var async = require('async');

module.exports = function(self, options) {

  self.localized = false;

  self.composeLocales = function() {
    self.nestedLocales = options.locales || [
      {
        name: 'default',
        label: 'Workflow'
      }
    ];
    
    self.locales = {};
    flattenLocales(self.nestedLocales);
    if (_.keys(self.locales).length > 1) {
      self.localized = true;
    }

    addDraftLocales();
    
    function flattenLocales(locales) {
      _.each(locales, function(locale) {
        self.locales[locale.name] = locale;
        if (locale.children) {
          flattenLocales(locale.children);
        }
      });
    }
    
    function addDraftLocales() {
      var newLocales = {};
      _.each(self.locales, function(locale, name) {
        newLocales[name] = locale;
        var draftLocale = _.cloneDeep(locale);
        draftLocale.name = draftLocale.name + '-draft';
        draftLocale.private = true;
        delete draftLocale.children;
        newLocales[draftLocale.name] = draftLocale;
      });
      self.locales = newLocales;
    }
    
    self.defaultLocale = options.defaultLocale || 'default';
    
  };
  
  self.composeOptions = function() {
    self.baseExcludeProperties = options.baseExcludeProperties || [
      '_id',
      'path',
      'rank',
      'level',
      'createdAt',
      'updatedAt',
      'lowSearchText',
      'highSearchText',
      'highSearchWords',
      'searchSummary',
      
      // Permissions are propagated across all locales by docAfterSave,
      // so it is redundant and inappropriate to include them in workflow
      'docPermissions',
      'loginRequired',
      'viewUsersIds',
      'viewGroupsIds',
      'editUsersIds',
      'editGroupsIds',
      'viewUsersRelationships',
      'viewGroupsRelationships',
      'editUsersRelationships',
      'editGroupsRelationships',
      // This one isn't even really part of the state, but it dirties the diff
      'applyLoginRequiredToSubpages',
      // Ditto — sometimes wind up in db even though they are ephemeral
      'viewUsersRemovedIds',
      'viewGroupsRemovedIds',
      'editUsersRemovedIds',
      'editGroupsRemovedIds',
      'advisoryLock'
    ];
    
    // Attachment fields themselves are not directly localized (they are not docs)
    self.excludeActions = (self.options.excludeActions || []).concat(self.options.baseExcludeActions || [ 'admin', 'edit-attachment' ]);
    
    self.includeVerbs = (self.options.includeVerbs || []).concat(self.options.baseIncludeVerbs  || [ 'admin', 'edit' ]);

    // Localizing users and groups raises serious security questions. If they have a public representation,
    // make a new doc type and join to it
    self.baseExcludeTypes = [ 'apostrophe-user', 'apostrophe-group' ];

    // In 2.x, workflow applies to every property not explicitly excluded,
    // so configuration is simpler (localization will refine this though)
    self.excludeProperties = self.baseExcludeProperties.concat(options.excludeProperties || []);
    
    self.includeTypes = options.includeTypes || false;
    self.excludeTypes = self.baseExcludeTypes.concat(options.excludeTypes || []);      

    if (self.options.hostnames) {
      self.hostnames = self.options.hostnames;
    }
        
    if (self.options.prefixes === true) {
      self.prefixes = {};
      _.each(self.locales, function(locale, name) {
        if (name !== self.apos.utils.slugify(name)) {
          throw new Error('apostrophe-workflow: if the "prefixes" option is set to `true`, then locale names must be slugs (hyphens not underscores; letters must be lowercase; no other punctuation). If they will not match set it to an object mapping locales to prefixes.');
        }
        self.prefixes[self.liveify(name)] = '/' + self.liveify(name);
      });
    } else if (self.options.prefixes) {
      _.each(self.options.prefixes, function(prefix, locale) {
        if (!_.has(self.locales, locale)) {
          throw new Error('apostrophe-workflow: prefixes option for locale ' + locale + ' does not correspond to any configured locale');
        }
        prefix = prefix || '';
        prefix = prefix.toString();
        if (!prefix.match(/^\/[^\/]+$/)) {
          throw new Error('apostrophe-workflow: prefixes option: prefix ' + prefix + ' is invalid. If present it must be / followed by non-slash characters only');
        }
      });
      self.prefixes = {};
      _.assign(self.prefixes, self.options.prefixes);
    }

  };

  // Ensure the given doc has a `workflowLocale` property; if not
  // supply it from `req.locale`, also creating a new `workflowGuid`
  // and invoking `ensureWorkflowLocaleForPathIndex`. 
  //
  // If the locale's type is not included in workflow, nothing happens.
  
  self.ensureWorkflowLocale = function(req, doc) {
    if (!self.includeType(doc.type)) {
      return;
    }
    // If the doc has no locale yet, set it to the current request's
    // locale, or the default locale
    if (!doc.workflowLocale) {
      doc.workflowLocale = req.locale || self.defaultLocale;
      if (!doc.workflowLocale.match(/\-draft$/)) {
        // Always create the draft first, so we can then find it by id successfully
        // via code that is overridden to look for drafts. All the locales get created
        // but we want to return the draft's _id
        doc.workflowLocale = self.draftify(doc.workflowLocale);
      }
      doc.workflowGuid = self.apos.utils.generateId();
      doc._workflowNew = true;
      self.ensureWorkflowLocaleForPathIndex(doc);
    }
  };
  
  // Adjust the slug of a page to take the prefix into account.
  // The UI and/or `pages.newChild` should have done this already, this
  // is a failsafe invoked by `docBeforeSave` and also in tasks.
  //
  // If the document is not a page, or has no locale, nothing happens.
  
  self.ensurePageSlugPrefix = function(doc) {
    var prefix = self.prefixes && self.prefixes[self.liveify(doc.workflowLocale)];
    if (!(prefix && self.apos.pages.isPage(doc) && doc.workflowLocale)) {
      return;
    }
    // Match the first component of the URL
    matches = doc.slug && doc.slug.match(/^\/([^\/]+)/);
    if (!matches) {
      // No first component or no slug at all
      doc.slug = prefix + (doc.slug || '/' + self.apos.utils.slugify(doc.title));
    } else {
      existing = matches[1];
      if (('/' + existing) === prefix) {
        // Good to go
      } else {
        // There is no existing locale prefix
        doc.slug = prefix + doc.slug;
      }
    }
  };

  // Provide a duplicate locale property, but only on pages, not pieces.
  // This enables us to use a sparse unique mongodb index. The property
  // should never be used for any other purpose.

  self.ensureWorkflowLocaleForPathIndex = function(doc) {
    if (doc.slug.match(/^\//)) {
      doc.workflowLocaleForPathIndex = doc.workflowLocale;
    }
  };

  // Given a doc, find all joins related to that doc: those in its own schema,
  // or in the schemas of its own widgets. These are returned as an array of
  // objects with `doc` and `field` properties, where `doc` may be the doc
  // itself or a widget within it, and `field` is the schema field definition
  // of the join. Only forward joins are returned.

  self.findJoinsInDoc = function(doc) {
    return self.findJoinsInDocSchema(doc).concat(self.findJoinsInAreas(doc));
  };
  
  // Given a doc, invoke `findJoinsInSchema` with that doc and its schema according to
  // its doc type manager, and return the result.

  self.findJoinsInDocSchema = function(doc) {
    var schema = self.apos.docs.getManager(doc.type).schema;
    return self.findJoinsInSchema(doc, schema);
  };

  // Given a doc, find joins in the schemas of widgets contained in the
  // areas of that doc and  return an array in which each element is an object with
  // `doc` and `field` properties. `doc` is a reference to the individual widget
  // in question, and `field` is the join field definition for that widget.
  // Only forward joins are returned.
  
  self.findJoinsInAreas = function(doc) {
    var widgets = [];
    self.apos.areas.walk(doc, function(area, dotPath) {
      widgets = widgets.concat(area.items);
    });
    var joins = [];
    _.each(widgets, function(widget) {
      var manager = self.apos.areas.getWidgetManager(widget.type);
      if (!manager) {
        // We already warn about obsolete widgets elsewhere, don't crash
        return;
      }
      schema = manager.schema;
      joins = joins.concat(self.findJoinsInSchema(widget, schema));
    });
    return joins;
  };
  
  // Given a doc (or widget) and a schema, find joins described by that schema and
  // return an array in which each element is an object with
  // `doc`, `field` and `value` properties. `doc` is a reference to the doc
  // passed to this method, `field` is a field definition, and `value` is the
  // value of the join if available (the doc was loaded with joins).
  //
  // Only forward joins are returned.

  self.findJoinsInSchema = function(doc, schema) {
    var fromArrays = [];
    return _.map(
      _.filter(
        schema, function(field) {
          if ((field.type === 'joinByOne') || (field.type === 'joinByArray')) {
            if (self.includeType(field.withType)) {
              return true;
            }
          }
          if (field.type === 'array') {
            _.each(doc[field.name] || [], function(doc) {
              fromArrays = fromArrays.concat(self.findJoinsInSchema(doc, field.schema));
            });
          }
        }
      ), function(field) {
        return { doc: doc, field: field, value: doc[field.name] };
      }
    ).concat(fromArrays);
  };

  self.getCreateSingletonOptions = function(req) {
    return {
      action: self.action,
      contextGuid: req.data.workflow.context && req.data.workflow.context.workflowGuid,
      locales: self.locales,
      locale: req.locale,
      nestedLocales: self.nestedLocales,
      prefixes: self.prefixes,
      hostnames: self.hostnames
    };
  };

  self.addToAdminBar = function() {
    var items = [];
    if (self.localized) {
      self.apos.adminBar.add(self.__meta.name + '-locale-picker-modal', 'Locales');
      items.push(self.__meta.name + '-locale-picker-modal');
    }
    self.apos.adminBar.add(self.__meta.name + '-manage-modal', self.localized ? 'Submissions' : 'Workflow');
    items.push(self.__meta.name + '-manage-modal');
    self.apos.adminBar.group({
      label: 'Workflow',
      items: items
    });
  };

  self.getContextProjection = function() {
    return {
      title: 1,
      slug: 1,
      path: 1,
      workflowLocale: 1,
      tags: 1,
      type: 1
    };
  };

  self.modulesReady = function(callback) {
    return self.ensureIndexes(callback);
  };
  
  self.ensureIndexes = function(callback) {
    return self.apos.docs.db.ensureIndex({ workflowGuid: 1 }, {}, callback);
  };

  // Create mongodb collection in which to permanently record each commit.
  // This is distinct from the versions collection, which becomes more sparse
  // as you move back through time and doesn't always give access to the
  // version that originally preceded a given version.
  
  self.enableCollection = function(callback) {
    self.db = self.apos.db.collection('aposWorkflowCommits');
    var indexes = [
      {
        createdAt: -1
      },
      {
        fromId: 1
      },
      {
        toId: 1
      },
      {
        workflowGuid: 1
      }
    ];
    return async.eachSeries(indexes, function(index, callback) {
      return self.db.ensureIndex(index, callback);
    }, callback);
  };

  // Given a dot path like a.b.c, return a.b
  self.getStem = function(dotPath) {
    var stem = dotPath.split(/\./);
    stem.pop();
    return stem = stem.join('.');
  };

  // Given a dot path like a.b.5, return
  // 5 as a number (not as a string)
  self.getIndex = function(dotPath) {
    var stem = dotPath.split(/\./);
    return parseInt(stem[stem.length - 1]);
  };

  // Invoked when the locale cannot be inferred from the session,
  // hostname or URL prefix. The default implementation simply
  // sets the locale to the default locale. You can override this
  // method as you see fit.

  self.guessLocale = function(req) {
    req.locale = self.defaultLocale;
  };
  
  self.enableCrossDomainSessionCache = function() {
    self.crossDomainSessionCache = self.apos.caches.get('apostrophe-workflow-cross-domain-session-cache');
  };
  
  self.acceptCrossDomainSessionToken = function(req) {
    var crossDomainSessionToken = self.apos.launder.string(req.query.workflowCrossDomainSessionToken);
    var sessionData;
    
    return async.series([
      get,
      clear
    ], function(err) {

      if (err) {
        console.error(err);
        return after();
      }

      _.each(_.keys(req.session), function(key) {
        delete req.session[key];
      });
      _.assign(req.session, JSON.parse(sessionData));
      return after();
      
      function after() {
        return req.res.redirect(self.apos.urls.build(req.url, { workflowCrossDomainSessionToken: null }));
      }
    });

    function get(callback) {
      return self.crossDomainSessionCache.get(crossDomainSessionToken, function(err, _sessionData) {
        sessionData = _sessionData;
        if (!sessionData) {
          return callback('expired or nonexistent cross domain session token');
        }
        return callback(err);
      });
    }

    function clear(callback) {
      return self.crossDomainSessionCache.set(crossDomainSessionToken, null, callback);
    }    
  };
                        
};
