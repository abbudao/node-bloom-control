/*
 * node-bloom-control
 *
 * Copyright 2017, Valerian Saliou
 * Author: Valerian Saliou <valerian@valeriansaliou.name>
 */


"use strict";


var net       = require("net");
var farmhash  = require("farmhash-modern");


/**
 * BloomControl
 * @class
 * @classdesc  Instanciates a new Bloom Control connector.
 * @param      {object} options
 */
var BloomControl = function(options) {
  // Sanitize options
  if (typeof options !== "object") {
    throw new Error("Invalid or missing options");
  }
  if (typeof options.shard !== "number" || options.shard < 0 ||
        options.shard > 255) {
    throw new Error("Invalid or missing options.shard");
  }
  if (typeof options.host !== "string" || !options.host) {
    throw new Error("Invalid or missing options.host");
  }
  if (typeof options.port !== "number" || options.port < 0 ||
        options.port > 65535) {
    throw new Error(
      "Invalid or missing options.port (because options.host is set)"
    );
  }
  if (typeof options.offlineStackMaxSize !== "undefined"  &&
        (typeof options.offlineStackMaxSize !== "number" ||
          options.offlineStackMaxSize < 0)) {
    throw new Error("Invalid options.offlineStackMaxSize");
  }

  // Environment
  var offlineStackMaxSizeDefault = 10000;

  // Storage space
  this.__options               = {
    shard               : options.shard,
    host                : (options.host   || null),
    port                : (options.port   || null),

    offlineStackMaxSize : (
      typeof options.offlineStackMaxSize === "number" ?
        options.offlineStackMaxSize : offlineStackMaxSizeDefault
    )
  };

  this.__client                = null;

  this.__isClosing             = false;
  this.__retryTimeout          = null;
  this.__pingInterval          = null;
  this.__unstackOfflineTimeout = null;

  this.__lastCommands          = [];

  this.__connectHandlers       = {};
  this.__responseHandlers      = {};

  this.__offlineStack          = [];
};


/**
 * BloomControl.prototype.connect
 * @public
 * @param  {object} [handlers]
 * @return {object} Bloom Control instance
 */
BloomControl.prototype.connect = function(handlers) {
  var self = this;

  // Assign handlers (overwrite w/ orders of priority)
  handlers = Object.assign(
    {}, self.__connectHandlers, handlers
  );

  // Flush any scheduled retry timeout
  if (self.__retryTimeout !== null) {
    clearTimeout(self.__retryTimeout);

    self.__retryTimeout = null;
  }

  if (self.__client === null) {
    // Register connect handlers
    self.__connectHandlers = {
      connected    : handlers.connected,
      disconnected : handlers.disconnected,
      timeout      : handlers.timeout,
      retrying     : handlers.retrying,
      error        : handlers.error
    };

    // Setup local client
    var client = new net.Socket();

    client.setNoDelay(true);    // Disable Nagle algorithm
    client.setTimeout(300000);  // Time-out after 5m

    // Initialize connected marker and data buffer
    var isConnected = false,
        dataBuffer  = "";

    // Construct all local event handler functions
    // Notice: this is done for performance and traceability reasons, as we \
    //   would prefer those functions to be named when debugging stack traces. \
    //   As well, defining them in advance ensures that they are not lazily \
    //   compiled again and again.
    var fnHandleConnect = function() {
      isConnected = true;

      // Setup ping interval
      self.__setupPingInterval(true);
    };

    var fnHandleData = function(data) {
      if (data) {
        // Read received data chunk (prepend it w/ pending buffer from \
        //   previous chunk cycles)
        var dataChunk = (dataBuffer + data.toString());

        if (dataChunk.length > 0) {
          // Iterate on all lines contained within this chunk (until there is \
          //   no more)
          var splitIndex = dataChunk.indexOf("\n");

          while (splitIndex !== -1) {
            // Acquire line content from data chunk
            var line = dataChunk.substring(0, splitIndex).trim();

            if (line) {
              self.__handleDataLine.bind(self)(client, line);
            }

            // Pull out current line from data chunk and update next split index
            dataChunk  = dataChunk.substring(splitIndex + 1);
            splitIndex = dataChunk.indexOf("\n");
          }

          // Assign remaining un-processed data chunk to data buffer, as the \
          //   rest of the next line might be coming at next data chunk event.
          dataBuffer = dataChunk;
        }
      }
    };

    var fnHandleTimeout = function() {
      client.end();

      // Failure (timeout)
      self.__triggerConnectHandler("timeout");
    };

    var fnHandleError = function(error) {
      if (isConnected === false) {
        client.destroy();

        // Failure (unknown)
        self.__triggerConnectHandler("error", error);
      }
    };

    var fnHandleClose = function(hadError) {
      if (isConnected === true) {
        client.destroy();

        // Cancel any pending offline timeout unstack
        if (self.__unstackOfflineTimeout !== null) {
          clearTimeout(self.__unstackOfflineTimeout);

          self.__unstackOfflineTimeout = null;
        }

        // Un-setup ping interval
        self.__setupPingInterval(false);

        // Clear all pending commands
        self.__lastCommands = [];

        // Failure (closed)
        self.__handleDisconnected.bind(self)();

        self.__triggerConnectHandler("disconnected");
      }
    };

    // Connect to Bloom Control endpoint
    client.connect(
      {
        port : self.__options.port,
        host : self.__options.host
      },

      fnHandleConnect
    );

    // Bind all event listeners
    client.on("data", fnHandleData);
    client.on("timeout", fnHandleTimeout);
    client.on("error", fnHandleError);
    client.on("close", fnHandleClose);
  } else {
    // Immediate success (already connected)
    self.__triggerConnectHandler("connected");
  }

  return self;
};


/**
 * BloomControl.prototype.on
 * @public
 * @param  {string}   type
 * @param  {function} handler
 * @return {undefined}
 */
BloomControl.prototype.on = function(type, handler) {
  this.__responseHandlers[type] = handler;
};


/**
 * BloomControl.prototype.off
 * @public
 * @param  {string}   type
 * @param  {function} handler
 * @return {undefined}
 */
BloomControl.prototype.off = function(type, handler) {
  delete this.__responseHandlers[type];
};


/**
 * BloomControl.prototype.purgeBucket
 * @public
 * @param  {string|object} cacheBucketID
 * @param  {function}      done
 * @return {boolean}       Whether bucket purge was executed now or deferred
 */
BloomControl.prototype.purgeBucket = function(cacheBucketID, done) {
  var executeResult = true;

  // Acquire arguments
  var purgeList = (
    (cacheBucketID instanceof Array) ? cacheBucketID : [cacheBucketID]
  );

  for (var i = 0; i < purgeList.length; i++) {
    var purgeItem = purgeList[i];

    if (!purgeItem) {
      throw new Error("Missing cacheBucketID");
    }

    // Execute command
    // Notice: push done callback for last pushed value only, so that a single \
    //   callback is fired upon completion for multiple purge values.
    executeResult = (
      this.__executeOrDefer(
        "purgeBucket",

        [
          purgeItem,
          ((i === (purgeList.length - 1)) ? done : undefined)
        ]
      ) && executeResult
    );
  }

  return executeResult;
};


/**
 * BloomControl.prototype.purgeAuth
 * @public
 * @param  {string|object} authIdentifier
 * @param  {string}        authToken
 * @param  {function}      done
 * @return {boolean}       Whether auth purge was executed now or deferred
 */
BloomControl.prototype.purgeAuth = function(authIdentifier, authToken, done) {
  var executeResult = true;

  // Acquire arguments
  var purgeList  = (
    (authIdentifier instanceof Array) ? authIdentifier :
      [[authIdentifier, authToken]]
  );
  var doneHandle = (typeof authToken === "function") ? authToken : done;

  for (var i = 0; i < purgeList.length; i++) {
    var purgeItem = purgeList[i];

    if (!purgeItem || !purgeItem[0] || !purgeItem[1]) {
      throw new Error("Missing authIdentifier or authToken");
    }

    // Execute command
    // Notice: push done callback for last pushed value only, so that a single \
    //   callback is fired upon completion for multiple purge values.
    executeResult = (
      this.__executeOrDefer(
        "purgeAuth",

        [
          purgeItem[0],
          purgeItem[1],
          ((i === (purgeList.length - 1)) ? doneHandle : undefined)
        ]
      ) && executeResult
    );
  }

  return executeResult;
};


/**
 * BloomControl.prototype.ping
 * @public
 * @param  {function} done
 * @return {undefined}
 */
BloomControl.prototype.ping = function(done) {
  if (this.__client !== null) {
    this.__execute("ping", [done]);
  }
};


/**
 * BloomControl.prototype.close
 * @public
 * @param  {function} done
 * @return {boolean}  Whether connection was closed now or not
 */
BloomControl.prototype.close = function(done) {
  if (this.__client !== null) {
    this.__execute("close", [done]);

    // Unbind client immediately
    this.__client = null;

    return true;
  }

  return false;
};


/**
 * BloomControl.prototype.__executeOrDefer
 * @private
 * @param  {string}  operation
 * @param  {object}  args
 * @return {boolean} Whether was executed now or deferred
 */
BloomControl.prototype.__executeOrDefer = function(operation, args) {
  // Execute now?
  if (this.__client !== null) {
    this.__execute(operation, args);

    return true;
  }

  // Defer.
  this.__defer(operation, args);

  return false;
};


/**
 * BloomControl.prototype.__execute
 * @private
 * @param  {string} operation
 * @param  {object} args
 * @return {undefined}
 */
BloomControl.prototype.__execute = function(operation, args) {
  // Execute operation now.
  this["__operation_$" + operation].apply(this, (args || []));
};


/**
 * BloomControl.prototype.__defer
 * @private
 * @param  {string} operation
 * @param  {object} args
 * @return {undefined}
 */
BloomControl.prototype.__defer = function(operation, args) {
  // Offline stack is disabled?
  if (this.__options.offlineStackMaxSize === 0) {
    // Notice: throw a 'String' instead of an 'Error' here, as errors capture \
    //   a stack trace which is not needed here, involving a huge \
    //   performance penalty which can be CPU-intensive at scale.
    throw (
      "Offline stack is disabled, cannot stack any operation until " +
        "Bloom Control connection is restored"
    );
  }

  // Offline stack is full?
  if (this.__offlineStack.length >= this.__options.offlineStackMaxSize) {
    // Notice: throw a 'String' instead of an 'Error' here, as errors capture \
    //   a stack trace which is not needed here, involving a huge \
    //   performance penalty which can be CPU-intensive at scale.
    throw (
      "Offline stack is full, cannot stack more operations until " +
        "Bloom Control connection is restored (maximum size set to: " +
        this.__options.offlineStackMaxSize + " entries)"
    );
  }

  // Push to offline stack
  this.__offlineStack.push([operation, (args || [])]);
};


/**
 * BloomControl.prototype.__operation_$purgeBucket
 * @private
 * @param  {string|object} cacheBucketID
 * @param  {function}      done
 * @return {undefined}
 */
BloomControl.prototype.__operation_$purgeBucket = function(
  cacheBucketID, done
) {
  this.__emit(
    ("FLUSHB " + this.__hash(cacheBucketID)), done
  );
};


/**
 * BloomControl.prototype.__operation_$purgeAuth
 * @private
 * @param  {string|object} authIdentifier
 * @param  {string}        authToken
 * @param  {function}      done
 * @return {undefined}
 */
BloomControl.prototype.__operation_$purgeAuth = function(
  authIdentifier, authToken, done
) {
  // Generate pristine HTTP authorization header
  var authHeader = (
    "Basic " + Buffer.from(authIdentifier + ":" + authToken).toString("base64")
  );

  this.__emit(
    ("FLUSHA " + this.__hash(authHeader)), done
  );
};


/**
 * BloomControl.prototype.__operation_$ping
 * @private
 * @param  {function} done
 * @return {undefined}
 */
BloomControl.prototype.__operation_$ping = function(done) {
  if (this.__client !== null) {
    this.__emit("PING", done);
  }
};


/**
 * BloomControl.prototype.__operation_$close
 * @private
 * @param  {function} done
 * @return {undefined}
 */
BloomControl.prototype.__operation_$close = function(done) {
  if (this.__client !== null) {
    this.__isClosing = true;

    this.__emit("QUIT", done);
  }
};


/**
 * BloomControl.prototype.__hash
 * @private
 * @param  {string} value
 * @return {string} Hexadecimal hash
 */
BloomControl.prototype.__hash = function(value) {
  // Validate input (prevents hashing DoS)
  if (!value) {
    throw new Error("Value to hash is empty");
  } else if (value.length > 2000) {
    throw new Error("Value to hash is too long");
  }

  // Hash input (hexadecimal output)
  return (
    farmhash.fingerprint64(value).toString(16)
  );
};


/**
 * BloomControl.prototype.__emit
 * @private
 * @param  {string}   command
 * @param  {function} done
 * @param  {object}   [client]
 * @return {undefined}
 */
BloomControl.prototype.__emit = function(command, done, client) {
  var result;

  if (this.__client !== null || client) {
    this.__lastCommands.push(command);

    (client || this.__client).write(command + "\n");
  } else {
    // Notice: pass a 'String' instead of an 'Error' here, as errors capture \
    //   a stack trace which is not needed here, involving a huge \
    //   performance penalty which can be CPU-intensive at scale.
    result = "Channel closed";
  }

  if (typeof done === "function") {
    done(result);
  }
};


/**
 * BloomControl.prototype.__triggerConnectHandler
 * @private
 * @param  {string} type
 * @param  {object} data
 * @return {undefined}
 */
BloomControl.prototype.__triggerConnectHandler = function(type, data) {
  if (typeof this.__connectHandlers[type] === "function") {
    this.__connectHandlers[type](data);
  }
};


/**
 * BloomControl.prototype.__triggerResponseHandler
 * @private
 * @param  {string} type
 * @return {undefined}
 */
BloomControl.prototype.__triggerResponseHandler = function(type) {
  var lastCommand = this.__lastCommands.shift();

  if (typeof this.__responseHandlers[type] === "function") {
    this.__responseHandlers[type](lastCommand);
  }
};


/**
 * BloomControl.prototype.__setupPingInterval
 * @private
 * @param  {boolean} [do_setup]
 * @return {undefined}
 */
BloomControl.prototype.__setupPingInterval = function(do_setup) {
  var self = this;

  // Cancel previous interval?
  if (this.__pingInterval !== null) {
    clearInterval(this.__pingInterval);

    this.__pingInterval = null;
  }

  if (do_setup === true) {
    // Schedule ping interval (every 60s)
    this.__pingInterval = setInterval(function() {
      self.ping();
    }, 60000);
  }
};


/**
 * BloomControl.prototype.__handleConnected
 * @private
 * @param  {object} client
 * @return {undefined}
 */
BloomControl.prototype.__handleConnected = function(client) {
  var self = this;

  if (self.__client === null) {
    self.__client = client;

    // Unstack pending offline operations (after an hold time)
    if (self.__offlineStack.length > 0) {
      self.__unstackOfflineTimeout = setTimeout(function() {
        self.__unstackOfflineTimeout = null;

        if (self.__client !== null) {
          while (self.__offlineStack.length > 0) {
            self.__execute.apply(self, self.__offlineStack.shift());
          }
        }
      }, 500);
    }
  }

  // Success (now connected)
  self.__triggerConnectHandler("connected");
};


/**
 * BloomControl.prototype.__handleDisconnected
 * @private
 * @return {undefined}
 */
BloomControl.prototype.__handleDisconnected = function() {
  var self = this;

  // Reset client
  self.__client = null;

  // Schedule retry?
  if (self.__isClosing !== true && self.__retryTimeout === null) {
    self.__retryTimeout = setTimeout(function() {
      self.__retryTimeout = null;

      self.connect({
        error : function() {
          // Failed retrying, schedule next retry
          self.__handleDisconnected();
        }
      });

      // Pending (retrying to connect)
      self.__triggerConnectHandler("retrying");
    }, 2000);
  }

  // Not closing anymore
  self.__isClosing = false;
};


/**
 * BloomControl.prototype.__handleDataLine
 * @private
 * @param  {object} client
 * @param  {string} line
 * @return {undefined}
 */
BloomControl.prototype.__handleDataLine = function(client, line) {
  // Ensure line matches recognized pattern
  var splitIndex = line.indexOf(" ");

  var lineSegments = (
    (splitIndex !== -1) ?
      [line.substring(0, splitIndex), line.substring(splitIndex + 1)] :
      [line, undefined]
  );

  if (lineSegments[0]) {
    // Trigger response handler (straight)
    this.__triggerResponseHandler(lineSegments[0]);

    // Route response command to handler
    var handler = this["__handleDataLine_" + lineSegments[0].toLowerCase()];

    if (typeof handler === "function") {
      handler.bind(this)(client, lineSegments[1]);
    }
  } else {
    throw new Error("Handled invalid data line");
  }
};


/**
 * BloomControl.prototype.__handleDataLine_hashreq
 * @private
 * @param  {object} client
 * @param  {string} argument
 * @return {undefined}
 */
BloomControl.prototype.__handleDataLine_hashreq = function(client, argument) {
  this.__emit(
    ("HASHRES " + this.__hash(argument)), undefined, client
  );
};


/**
 * BloomControl.prototype.__handleDataLine_started
 * @private
 * @param  {object} client
 * @param  {string} argument
 * @return {undefined}
 */
BloomControl.prototype.__handleDataLine_started = function(client, argument) {
  // Select shard
  this.__emit(
    ("SHARD " + this.__options.shard.toString()), undefined, client
  );

  // Now connected
  this.__handleConnected(client);
};


/**
 * BloomControl.prototype.__handleDataLine_ended
 * @private
 * @param  {object} client
 * @param  {string} argument
 * @return {undefined}
 */
BloomControl.prototype.__handleDataLine_ended = function(client, argument) {
  // Incompatible hasher? (critical error)
  if (argument === "incompatible_hasher") {
    throw new Error(
      "Local hasher is not compatible with remote Bloom hasher, " +
        "please double-check your architecture. Aborting there."
    );
  }

  client.destroy();
};


exports.BloomControl = BloomControl;
