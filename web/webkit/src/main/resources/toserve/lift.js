(function(window, undefined) {
  "use strict";

  window.lift = (function() {
    // "private" vars
    var ajaxQueue = [],
        ajaxInProcess = null,
        ajaxVersion = 0,
        doCycleQueueCnt = 0,
        ajaxShowing = false,
        pageId = "",
        uriSuffix,
        sessionId = "",
        toWatch = {},
        knownPromises = {};

    // default settings
    var settings = {
      /**
        * Contains the Ajax URI path used by Lift to process Ajax requests.
        */
      ajaxPath: "ajax_request",
      ajaxRetryCount: 3,
      ajaxPostTimeout: 5000,

      /**
        * By default lift uses a garbage-collection mechanism of removing unused bound functions from LiftSesssion.
        * Setting this to false will disable this mechanisms and there will be no Ajax polling requests attempted.
        */
      enableGc: true,

      /**
        * The polling interval for background Ajax requests to prevent functions of being garbage collected.
        * Default value is set to 75 seconds.
        */
      gcPollingInterval: 75000,

      /**
        * The polling interval for background Ajax requests to keep functions to not be garbage collected.
        * This will be applied if the Ajax request will fail. Default value is set to 15 seconds.
        */
      gcFailureRetryTimeout: 15000,
      logError: function(msg) {
        consoleOrAlert(msg);
      },
      ajaxOnFailure: function() {
        window.alert("The server cannot be contacted at this time");
      },
      ajaxOnStart: function() {
        // noop
      },
      ajaxOnEnd: function() {
        // noop
      },
      ajaxOnSessionLost: function() {
        window.location.reload();
      },
      ajaxPost: function(url, data, dataType, onSuccess, onFailure) {
        consoleOrAlert("ajaxPost function must be defined in settings");
        onFailure();
      },
      ajaxGet: function() {
        consoleOrAlert("ajaxGet function must be defined in settings");
      },
      cometGetTimeout: 140000,
      cometFailureRetryTimeout: 10000,
      cometOnSessionLost: function() {
        window.location.href = "/";
      },
      cometPath: "comet_request",
      cometServer: "",
      cometOnError: function(e) {
        if (window.console && typeof window.console.error === 'function') {
          window.console.error(e.stack || e);
        }
        throw e;
      }
    };

    // "private" funcs
    function consoleOrAlert(msg) {
      if (window.console && typeof window.console.error === 'function') {
        window.console.error(msg);
      }
      else {
        window.alert(msg);
      }
    }

    ////////////////////////////////////////////////
    ///// Ajax /////////////////////////////////////
    ////////////////////////////////////////////////

    function appendToQueue(data, onSuccess, onFailure, responseType, onUploadProgress) {
      var toSend = {
        retryCnt: 0,
        when: (new Date()).getTime(),
        data: data,
        onSuccess: onSuccess,
        onFailure: onFailure,
        responseType: responseType,
        onUploadProgress: onUploadProgress,
        version: ajaxVersion++
      };

      // Make sure we wrap when we hit JS max int.
      var version = ajaxVersion;
      if ((version - (version + 1) !== -1) || (version - (version - 1) !== 1)) {
        ajaxVersion = 0;
      }

      // for adding a func to call
      if (uriSuffix) {
        data += '&' + uriSuffix;
        toSend.data = data;
        uriSuffix = undefined;
      }

      ajaxQueue.push(toSend);
      ajaxQueueSort();
      doCycleQueueCnt++;
      doAjaxCycle();

      return false; // buttons in forms don't trigger the form
    }

    function ajaxQueueSort() {
      ajaxQueue.sort(function (a, b) { return a.when - b.when; });
    }

    function startAjax() {
      ajaxShowing = true;
      settings.ajaxOnStart();
    }

    function endAjax() {
      ajaxShowing = false;
      settings.ajaxOnEnd();
    }

    function testAndShowAjax() {
      if (ajaxShowing && ajaxQueue.length === 0 && ajaxInProcess === null) {
        endAjax();
      }
      else if (!ajaxShowing && (ajaxQueue.length > 0 || ajaxInProcess !== null)) {
        startAjax();
      }
    }

    /*function traverseAndCall(node, func) {
      if (node.nodeType == 1) {
        func(node);
      }
      var i = 0;
      var cn = node.childNodes;

      for (i = 0; i < cn.length; i++) {
        traverseAndCall(cn.item(i), func);
      }
    }*/

    function calcAjaxUrl(url, version) {
      if (settings.enableGc) {
        var replacement = settings.ajaxPath+'/'+pageId;
        if (version !== null) {
          replacement += ('-'+version.toString(36)) + (ajaxQueue.length > 35 ? 35 : ajaxQueue.length).toString(36);
        }
        return url.replace(settings.ajaxPath, replacement);
      }
      else {
        return url;
      }
    }

    function registerGC() {
      var data = "__lift__GC=_";

      settings.ajaxPost(
        calcAjaxUrl("/"+settings.ajaxPath+"/", null),
        data,
        "script",
        successRegisterGC,
        failRegisterGC
      );
    }

    function successRegisterGC() {
      setTimeout(registerGC, settings.gcPollingInterval);
    }

    function failRegisterGC() {
      setTimeout(registerGC, settings.gcFailureRetryTimeout);
    }

    function doCycleIn200() {
      doCycleQueueCnt++;
      setTimeout(doAjaxCycle, 200);
    }

    function doAjaxCycle() {
      if (doCycleQueueCnt > 0) {
        doCycleQueueCnt--;
      }

      var queue = ajaxQueue;
      if (queue.length > 0) {
        var now = (new Date()).getTime();
        if (ajaxInProcess === null && queue[0].when <= now) {
          var aboutToSend = queue.shift();

          ajaxInProcess = aboutToSend;

          var successFunc = function(data) {
            ajaxInProcess = null;
            if (aboutToSend.onSuccess) {
              aboutToSend.onSuccess(data);
            }
            doCycleQueueCnt++;
            doAjaxCycle();
          };

          var failureFunc = function() {
            ajaxInProcess = null;
            var cnt = aboutToSend.retryCnt;

            if (arguments.length === 3 && arguments[1] === 'parsererror') {
              settings.logError('The server call succeeded, but the returned Javascript contains an error: '+arguments[2]);
            }

            if (cnt < settings.ajaxRetryCount) {
              aboutToSend.retryCnt = cnt + 1;
              var now = (new Date()).getTime();
              aboutToSend.when = now + (1000 * Math.pow(2, cnt));
              queue.push(aboutToSend);
              ajaxQueueSort();
            }
            else {
              if (aboutToSend.onFailure) {
                aboutToSend.onFailure();
              }
              else {
                settings.ajaxOnFailure();
              }
            }
            doCycleQueueCnt++;
            doAjaxCycle();
          };

          if (aboutToSend.responseType !== undefined &&
              aboutToSend.responseType !== null &&
              aboutToSend.responseType.toLowerCase() === "json")
          {
            settings.ajaxPost(
              calcAjaxUrl("/"+settings.ajaxPath+"/", null),
              aboutToSend.data,
              "json",
              successFunc,
              failureFunc,
              aboutToSend.onUploadProgress
            );
          }
          else {
            settings.ajaxPost(
              calcAjaxUrl("/"+settings.ajaxPath+"/", aboutToSend.version),
              aboutToSend.data,
              "script",
              successFunc,
              failureFunc,
              aboutToSend.onUploadProgress
            );
          }
        }
      }

      testAndShowAjax();
      if (doCycleQueueCnt <= 0) {
        doCycleIn200();
      }
    }

    ////////////////////////////////////////////////
    ///// Comet ////////////////////////////////////
    ////////////////////////////////////////////////

    // http://stackoverflow.com/questions/4994201/is-object-empty
    function is_empty(obj) {
      // null and undefined are empty
      if (obj == null) {
        return true;
      }
      // Assume if it has a length property with a non-zero value
      // that that property is correct.
      if (obj.length && obj.length > 0) {
        return false;
      }
      if (obj.length === 0) {
        return true;
      }

      for (var key in obj) {
        if (hasOwnProperty.call(obj, key)) {
          return false;
        }
      }
      // Doesn't handle toString and toValue enumeration bugs in IE < 9
      return true;
    }

    function cometFailureFunc() {
      setTimeout(cometEntry, settings.cometFailureRetryTimeout);
    }

    function cometSuccessFunc() {
      setTimeout(cometEntry, 100);
    }

    function calcCometPath() {
      return settings.cometServer+"/"+settings.cometPath+"/" + Math.floor(Math.random() * 100000000000) + "/" + sessionId + "/" + pageId;
    }

    function cometEntry() {
      var isEmpty = is_empty(toWatch);

      if (!isEmpty) {
        uriSuffix = undefined;
        settings.ajaxGet(
          calcCometPath(),
          toWatch,
          cometSuccessFunc,
          cometFailureFunc
        );
      }
    }

    function unlistWatch(watchId) {
      var ret = [];
      for (var item in toWatch) {
        if (item !== watchId) {
          ret.push(item);
        }
      }
      toWatch = ret;
    }

    // Call on page load
    function registerComet(tw, sessId) {
      toWatch = tw;
      sessionId = sessId;

      cometSuccessFunc();
    }


    ////////////////////////////////////////////////
    ///// Promises /////////////////////////////////
    ////////////////////////////////////////////////
    function randStr() {
      return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }

    function makeGuid() {
      return randStr() + randStr() + '-' + randStr() + '-' + randStr() + '-' +
             randStr() + '-' + randStr() + randStr() + randStr();
    }

    function removePromise(g) {
      knownPromises[g] = undefined;
    }

    function Promise() {
      // "private" vars
      var self = this,
          _values = [],
          _events = [],
          _failMsg = "",
          _valueFuncs = [],
          _doneFuncs = [],
          _failureFuncs = [],
          _eventFuncs = [],
          _done = false,
          _failed = false;

      // "private" funcs
      function successMsg(value) {
        if (_done || _failed) return;
        _values.push(value);
        for (var f in _valueFuncs) {
          _valueFuncs[f](value);
        }
      }

      function failMsg(msg) {
        if (_done || _failed) return;
        removePromise(self.guid);
        _failed = true;
        _failMsg = msg;

        for (var f in _failureFuncs) {
          _failureFuncs[f](msg);
        }
      }

      function doneMsg() {
        if (_done || _failed) return;
        removePromise(self.guid);
        _done = true;

        for (var f in _doneFuncs) {
          _doneFuncs[f]();
        }
      }

      // public funcs
      self.guid = makeGuid();

      self.processMsg = function(evt) {
        if (_done || _failed) return;
        _events.push(evt);
        for (var v in _eventFuncs) {
          try { _eventFuncs[v](evt); }
          catch (e) {
            settings.logError(e);
          }
        };

        if (evt.done) {
          doneMsg();
        }
        else if (evt.success) {
          successMsg(evt.success);
        }
        else if (evt.failure) {
          failMsg(evt.failure);
        }
      };

      self.then = function(f) {
        _valueFuncs.push(f);

        for (var v in _values) {
          try { f(_values[v]); }
          catch (e) {
            settings.logError(e);
          }
        }

        return self;
      };

      self.fail = function(f) {
        _failureFuncs.push(f);
        if (_failed) {
          try { f(_failMsg); }
          catch (e) {
            settings.logError(e);
          }
        };

        return self;
      };

      self.done = function(f) {
        _doneFuncs.push(f);
        if (_done) {
          try { f(); }
          catch (e) {
            settings.logError(e);
          }
        }

        return this;
      };

      self.onEvent = function(f) {
        _eventFuncs.push(f);
        for (var v in _events) {
          try { f(_events[v]); }
          catch (e) {
            settings.logError(e);
          }
        };

        return this;
      };

      self.map = function(f) {
        var ret = new Promise();

        done(function() {
          ret.doneMsg();
        });

        fail(function (m) {
          ret.failMsg(m);
        });

        then(function (v) {
          ret.successMsg(f(v));
        });

        return ret;
      };
    }

    ////////////////////////////////////////////////
    ///// Public Object /////////////////////////////////
    ////////////////////////////////////////////////
    return {
      init: function(options) {
        // override default settings
        this.extend(settings, options);
        // start the cycle
        doCycleIn200();
      },
      logError: settings.logError,
      ajax: appendToQueue,
      register: successRegisterGC,
      ajaxOnSessionLost: function() {
        settings.ajaxOnSessionLost();
      },
      calcAjaxUrl: calcAjaxUrl,
      registerComet: registerComet,
      cometOnSessionLost: function() {
        settings.cometOnSessionLost();
      },
      cometOnError: function(e) {
        settings.cometOnError(e);
      },
      unlistWatch: unlistWatch,
      setToWatch: function(tw) {
        toWatch = tw;
      },
      setPageId: function(pgId) {
        pageId = pgId;
      },
      setUriSuffix: function(suffix) {
        uriSuffix = suffix;
      },
      updWatch: function(id, when) {
        if (toWatch[id] !== undefined) {
          toWatch[id] = when;
        }
      },
      extend: function(obj1, obj2) {
        for(var item in obj2) {
          if (obj2.hasOwnProperty(item)) {
            obj1[item] = obj2[item];
          }
        }
      },
      createPromise: function() {
        var promise = new Promise();
        knownPromises[promise.guid] = promise;
        return promise;
      },
      sendEvent: function(g, evt) {
        var p = knownPromises[g];
        if (p) {
          p.processMsg(evt);
        }
      }
    };
  })();

  window.liftJQuery = {
    ajaxPost: function(url, data, dataType, onSuccess, onFailure) {
      var processData = true,
          contentType = 'application/x-www-form-urlencoded; charset=UTF-8';

      if (typeof data === "object") { // FormData
        processData = false;  // tell jQuery not to process the data
        contentType = false; // tell jQuery not to set contentType
      }

      jQuery.ajax({
        url: url,
        data: data,
        type: "POST",
        dataType: dataType,
        timeout: this.ajaxPostTimeout,
        cache: false,
        success: onSuccess,
        error: onFailure,
        processData: processData,
        contentType: contentType
      });
    },
    ajaxGet: function(url, data, onSuccess, onFailure) {
      jQuery.ajax({
        url: url,
        data: data,
        type: "GET",
        dataType: "script",
        timeout: this.cometGetTimeout,
        cache: false,
        success: onSuccess,
        error: onFailure
      });
    }
  };

  window.liftVanilla = {
    ajaxPost: function(url, data, dataType, onSuccess, onFailure, onUploadProgress) {
      var settings = this;

      var xhr = new XMLHttpRequest();

      if (onUploadProgress) {
        xhr.upload.addEventListener("progress", onUploadProgress, false);
      }

      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) { // Done
          if (xhr.status === 200) {
            if (dataType === "script") {
              try {
                eval(xhr.responseText);
              }
              catch (e) {
                settings.logError('The server call succeeded, but the returned Javascript contains an error: '+e);
              }
              finally {
                onSuccess();
              }
            }
            else if (dataType === "json") {
              var obj = {};
              try {
                obj = JSON.parse(xhr.responseText);
              }
              catch(e) {
                settings.logError('The server call succeeded, but the returned JSON contains an error: '+e);
              }
              finally {
                onSuccess(obj);
              }
            }
            else {
              settings.logError("Unknown data type: "+dataType);
            }
          }
          else {
            onFailure();
          }
        }
      };

      xhr.open("POST", url, true);
      xhr.timeout = settings.ajaxPostTimeout;

      // set content-type header if the form has been serialized into a string
      if (typeof data === "string") {
        xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
      }

      // These just mimic what jQuery produces
      if (dataType === "script") {
        xhr.setRequestHeader("Accept", "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01");
      }
      else if (dataType === "json") {
        xhr.setRequestHeader("Accept", "application/json, text/javascript, */*; q=0.01");
      }
      xhr.send(data);
    },
    ajaxGet: function(url, data, onSuccess, onFailure) {
      var settings = this;

      // create query string
      var qs = "";
      for (var key in data) {
        if (qs !== "") {
          qs += "&";
        }
        qs += key + "=" + data[key];
      }

      var xhr = new XMLHttpRequest();

      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) { // Done
          if (xhr.status === 200) {
            try {
              eval(xhr.responseText);
            }
            catch (e) {
              settings.logError('The server call succeeded, but the returned Javascript contains an error: '+e);
            }
            finally {
              onSuccess();
            }
          }
          else {
            onFailure();
          }
        }
      };

      if (qs !== "") {
        url = url+"?"+qs;
      }

      xhr.open("GET", url, true);
      xhr.timeout = settings.cometGetTimeout;
      xhr.setRequestHeader("Accept", "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01");
      xhr.send();
    }
  };

  // legacy
  window.liftAjax = {
    lift_successRegisterGC: window.lift.register,
    lift_ajaxHandler: window.lift.ajax,
    lift_sessionLost: window.lift.ajaxOnSessionLost,
    addPageNameAndVersion: window.lift.calcAjaxUrl
  };

  window.liftUtils = {
    lift_blurIfReturn: function(e) {
      var code;
      if (!e) {
        e = window.event;
      }
      if (e.keyCode) {
        code = e.keyCode;
      }
      else if (e.which) {
        code = e.which;
      }

      var targ;

      if (e.target) {
        targ = e.target;
      }
      else if (e.srcElement) {
        targ = e.srcElement;
      }
      if (targ.nodeType === 3) { // defeat Safari bug
        targ = targ.parentNode;
      }
      if (code === 13) {
        targ.blur();
        return false;
      }
      else {
        return true;
      }
    }
  };

})(this);
