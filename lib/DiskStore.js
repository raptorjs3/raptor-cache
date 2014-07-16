var nodePath = require('path');
var logger = require('raptor-logging').logger(module);
var mkdirp = require('mkdirp');
var DataHolder = require('raptor-async/DataHolder');
var DEFAULT_FLUSH_DELAY = 1000;
var fs = require('fs');
var binary = require('binary');
var CacheEntry = require('./CacheEntry');
var ok = require('assert').ok;
var uuid = require('node-uuid');
var through = require('through');

var util = require('./util');

var CACHE_VERSION = 1;
var MODE_SINGLE_FILE = 1;
var MODE_MULTI_FILE = 2;


function isObjectEmpty(o) {
    if (!o) {
        return true;
    }
    
    for (var k in o) {
        if (o.hasOwnProperty(k)) {
            return false;
        }
    }
    return true;
}

function getReaderFunc(store, cacheEntry) {

    var fullPath = nodePath.join(store.dir, cacheEntry.meta.file);

    function doCreateReadStream() {
        return fs.createReadStream(fullPath, {encoding: store.encoding});
    }

    var writeFileDataHolder = cacheEntry.data.writeFileDataHolder;

    if (writeFileDataHolder) {
        return function reader() {
            return util.createDelayedFileReadStream(fullPath, store.encoding, writeFileDataHolder);
        };
        
    } else {
        return doCreateReadStream;
    }
}

function readFromDisk(store, callback) {
    logger.debug('readFromDisk()');
    
    if (store.cache) {
        // If the cache has already been read from disk then just invoke 
        // the callback immediately
        if (callback) {
            callback(null, store.cache);
        }
        return;
    }

    if (store.readDataHolder) {
        // If we have already started reading the initial cache from disk then
        // just piggy back off the existing read by attaching a listener to the
        // async data holder
        if (callback) {
            store.readDataHolder.done(callback);
        }

        return;
    }

    // Create a new async data holder to keep track of the fact that we have 
    // started to read the cache file from disk
    var readDataHolder = store.readDataHolder = new DataHolder();

    if (callback) {
        // If a callback was provided then we need to attach the listener
        // to the async data holder for this read operation
        readDataHolder.done(callback);
    }

    // Create an empty cache object that we will populate with the cache entries
    var cache = {};

    // Keep a flag to avoid invoking reject or resolve multiple times
    var finished = false;

    function done() {
        logger.debug('readFromDisk() - done');
        if (finished) {
            return;
        }

        finished = true;

        store.readDataHolder = null;
        store.cache = cache;

        // While reaading from disk the cache may have been modified
        // using either "put" or "remove". These pending updates were
        // applied to a temporary cache that we need to now apply to the 
        // cache loaded from disk
        var pendingCache = store.pendingCache;

        if (pendingCache) {
            for (var k in pendingCache) {
                if (pendingCache.hasOwnProperty(k)) {
                    var v = pendingCache[k];
                    if (v == null) { // A remove is handled by setting the value to undefined
                        // Use "remove" so that the flush will happen correctly
                        store.remove(k);
                    } else {
                        // Use "put" so that the flush will happen correctly
                        store.put(k, v);
                    }
                }
            }
            store.pendingCache = null;    
        }

        // Make sure to resolve only after applying any writes that occurred before the read finished
        readDataHolder.resolve(cache);
    }

    logger.debug('readFromDisk() - reading: ', store.file);

    var inStream = fs.createReadStream(store.file);

    var versionIncompatible = false;

    // The cache is written to disk in an efficient binary format where each record has the following format:
    // <key-byte-length-16bits-unsigned-little-endian><key-bytes><value-byte-length-32bits-unsigned-little-endian><value-bytes>
    var parseStream = binary()
        .word8('version')
        .tap(function(vars) {
            var version = vars.version;
            if (version !== store.version) {
                versionIncompatible = true;
                inStream.unpipe(parseStream);
                done();
            }
        })
        .word8('mode')
        .tap(function(vars) {
            store.mode = vars.mode;
        })
        .loop(function(end, vars) {
            if (versionIncompatible) {
                return end();
            }

            var cacheEntry = null;

            this
                .word16lu('keyLen') 
                .tap(function(vars) {
                    var keyLen = vars.keyLen;
                    logger.debug('readFromDisk: keyLen: ', keyLen);
                    this.buffer('key', keyLen);
                })
                .tap(function(vars) {
                    var key = vars.key.toString('utf8');
                    cacheEntry = new CacheEntry({
                            key: key
                        });

                    if (store.deserialize) {
                        cacheEntry.deserialize = store.deserialize;
                        cacheEntry.encoding = store.encoding;
                        cacheEntry.deserialized = false;
                    }

                })
                .word16lu('metaLen') 
                .tap(function(vars) {
                    var metaLen = vars.metaLen;
                    logger.debug('readFromDisk: metaLen: ', metaLen);
                    if (metaLen > 0) {
                        this.buffer('meta', metaLen);    
                    }
                    
                })
                .tap(function(vars) {
                    var metaBuffer = vars.meta;
                    if (metaBuffer) {
                        var metaJSON = metaBuffer.toString('utf8');
                        logger.debug('meta for ', cacheEntry.key, ':', metaJSON);
                        cacheEntry.meta = JSON.parse(metaJSON);
                    }

                    if (!store.isCacheEntryValid || store.isCacheEntryValid(cacheEntry)) {
                        cache[cacheEntry.key] = cacheEntry;
                    }

                    // Even if we are skipping this entry we still need to read through the
                    // remaining bytes...
                    if (store.mode === MODE_SINGLE_FILE) {
                        // The value is stored in the same file...
                        this.word32lu('valueLen')
                            .tap(function(vars) {
                                var valueLen = vars.valueLen;
                                logger.debug('readFromDisk: valueLen: ', valueLen);
                                this.buffer('value', valueLen);
                            })
                            .tap(function(vars) {
                                var value = vars.value;

                                if (store.encoding) {
                                    value = value.toString(store.encoding);
                                }

                                cacheEntry.value = value;
                                this.flush();
                            });
                    } else {
                        this.tap(function() {
                            cacheEntry.reader = getReaderFunc(store, cacheEntry);    
                        });
                    }
                    
                });

            
        });
            

    inStream.on('error', done);
    inStream.on('end', done); // <-- This is the one that will trigger done() if everything goes through successfully
    parseStream.on('error', done);
    // parseStream.on('end', done);

    inStream.pipe(parseStream); // pipe the input file stream to the binary parser
}

function scheduleFlush(store) {
    if (store.flushDelay < 0) {
        return;
    }

    if (store.flushingDataHolder) {
        // If we already flushing then we will need to wait for the
        // current flush to complete before scheduling the next flush
        // so set a flag to trigger a flush to be scheduled after the
        // current flush finishes
        store.writeAfterFlush = true;
    } else {
        if (store.flushTimeoutID) {
            clearTimeout(store.flushTimeoutID);
            store.flushTimeoutID = null;
        }

        store.flushTimeoutID = setTimeout(function() {
            store.flushTimeoutID = null;
            store.flush();
        }, store.flushDelay);    
    }
}

function getUniqueFile() {
    var id = uuid.v4();
    var l1 = id.substring(0, 2);
    var l2 = id.substring(2);
    return l1 + '/' + l2.replace(/-/g, '');
}

function writeCacheValueToSeparateFile(store, cacheEntry) {

    if (cacheEntry.meta.file || cacheEntry.data.writeFileDataHolder) {
        // The cache entry has already been written to disk or it is in the process
        // of being written to disk... nothing to do
        return;
    }

    logger.debug('writeCacheValueToSeparateFile() - key: ', cacheEntry.key);
    var key = cacheEntry.key;
    var encoding = store.encoding;

    var writeFileDataHolder = cacheEntry.data.writeFileDataHolder = new DataHolder();
    var relPath = getUniqueFile();
    cacheEntry.meta.file = relPath;

    var originalReader = cacheEntry.reader;
    cacheEntry.reader = getReaderFunc(store, cacheEntry); // Replace the original reader with a new reader... one that will read from the separate file that will write to

    var value = cacheEntry.value;
    if (value != null) {
        // Remove the value from the cache entry since we are flushing it to disk
        // and do not want to keep it in memory
        delete cacheEntry.value;
    }

    var fullPath = nodePath.join(store.dir, relPath);
    var parentDir = nodePath.dirname(fullPath);

    function done(err) {
        if (err) {
            writeFileDataHolder.reject(err);
        } else {
            writeFileDataHolder.resolve(relPath);
        }

        delete cacheEntry.data.writeFileDataHolder;
    }

    mkdirp(parentDir, function(err) {
        if (err) {
            return done(err);
        }

        if (value != null) {
            if (typeof value !== 'string' && !(value instanceof Buffer)) {
                var serialize = store.serialize;

                if (!serialize) {
                    throw new Error('Serializer is required for non-String/Buffer values');
                }

                value = serialize(value);
            }

            if (typeof value === 'string') {
                value = new Buffer(value, encoding);
            }

            fs.writeFile(fullPath, value, done);
            
        } else if (originalReader) {
            var inStream = originalReader();
            if (!inStream || typeof inStream.pipe !== 'function') {
                throw new Error('Cache reader for key "' + key + '" did not return a stream');
            }

            var outStream = fs.createWriteStream(fullPath, {encoding: encoding});
            outStream.on('close', done);
            inStream.pipe(outStream);
        } else {
            throw new Error('Illegal state');
        }
    });    
}

function removeExternalCacheFile(cacheEntry) {
    if (cacheEntry.writeFileDataHolder) {
        cacheEntry.writeFileDataHolder.done(function(err, file) {
            if (err) {
                return;
            }
            delete cacheEntry.meta.file;
            fs.unlink(file, function() {});
        });
    } else if (cacheEntry.meta.file) {
        fs.unlink(cacheEntry.meta.file, function() {});
        delete cacheEntry.meta.file;
    } else {
        throw new Error('Illegal state');
    }
}

/**
 * This cache store has the following characteristics:
 * - An in-memory representation is maintained at all times
 * - The in-memory cache is backed by a disk cache that is stored in a single file
 * - The cache file is read in its entirety the first time the cache is read or written to
 * - Whenever the in-memory cache is modified, a flush is scheduled. If a flush had already been scheduled then it is cancelled so that
 *     flushes can be batched up. Essentially, after a x delay of no activity the in-memory cache is flushed to disk
 * - Values put into the cache must be an instance of Buffer
 * - Values cannot be null or undefined
 *
 * NOTES:
 * - This cache store is not suitable for storing very large amounts of data since it is all kept in memory
 *
 * Configuration options:
 * - flushDelay (int) - The amount of delay in ms after a modification to flush the updated cache to disk. -1 will disable autoamtic flushing. 0 will result in an immediate flush
 * 
 * @param {Object} config Configuration options for this cache (see above)
 */
function DiskStore(config) {
    if (!config) {
        config = {};
    }

    var dir = config.dir;

    if (!dir) {
        dir = nodePath.join(process.cwd(), '.cache');
    }

    this.flushDelay = config.flushDelay || DEFAULT_FLUSH_DELAY;
    this.dir = dir;

    this.mode = config.singleFile === false ? MODE_MULTI_FILE : MODE_SINGLE_FILE;
    this.encoding = config.encoding;
    this.serialize = config.serialize;
    this.deserialize = config.deserialize;

    this.version = CACHE_VERSION;
    this.file = nodePath.join(dir, 'cache');

    this._reset();

    this.isCacheEntryValid = null;
    
    mkdirp.sync(nodePath.dirname(this.file));
}

DiskStore.prototype = {
    _reset: function() {
        this.readDataHolder = null;
        this.cache = null;
        this.flushTimeoutID = null;
        this.pendingCache = null;
        this.flushingDataHolder = null;
        this.writeAfterFlush = false;
        this.modified = false;
    },

    free: function() {
        var _this = this;

        // Don't reset things in the middle of a pending read or flush...
        if (this.readDataHolder) {
            this.readDataHolder.done(function() {
                _this.release();
            });
        } else if (this.flushingDataHolder) {
            this.flushingDataHolder.done(function() {
                _this.release();
            });
        } else {
            this._reset();
        }
    },

    get: function(key, callback) {

        if (this.cache) {
            return callback(null, this.cache[key]);
        }

        if (this.pendingCache && this.pendingCache.hasOwnProperty(key)) {
            return callback(null, this.pendingCache[key]);
        }

        readFromDisk(this, function(err, cache) {
            if (err) {
                return callback(err);
            }

            callback(null, cache[key]);
        });
    },

    put: function(key, cacheEntry) {
        ok(typeof key === 'string', 'key should be a string');
        ok(cacheEntry != null, 'cacheEntry is required');

        if (!(cacheEntry instanceof CacheEntry)) {
            var value = cacheEntry;
            cacheEntry = new CacheEntry({
                key: key,
                value: value
            });
        } else {
            cacheEntry.key = key;
        }

        if (this.deserialize) {
            cacheEntry.deserialize = this.deserialize;
        }

        if (this.mode === MODE_MULTI_FILE) {
            writeCacheValueToSeparateFile(this, cacheEntry);
        }

        if (this.cache) {
            this.cache[key] = cacheEntry;
            this.modified = true;
            scheduleFlush(this);
        } else {
            if (!this.pendingCache) {
                this.pendingCache = {};
            }

            this.pendingCache[key] = cacheEntry;

            // Start reading from disk (it not started already) so that
            // we can update the cache and apply the "puts" and then flush
            // the cache back to disk
            readFromDisk(this);
        }
    },

    remove: function(key) {
        if (this.cache) {
            if (this.mode === MODE_MULTI_FILE) {
                var cacheEntry = this.cache[key];
                if (cacheEntry) {
                    removeExternalCacheFile(cacheEntry);    
                }
            }

            delete this.cache[key];
            this.modified = true;
            scheduleFlush(this);
        } else {
            if (!this.pendingCache) {
                this.pendingCache = {};
            }

            this.pendingCache[key] = undefined;

            // Start reading from disk (it not started already) so that
            // we can update the cache and apply the updates and then flush
            // the cache back to disk
            readFromDisk(this);
        }
    },

    flush: function(callback) {
        
        var _this = this;

        if (!this.cache) {
            readFromDisk(this, function(err) {
                if (err) {
                    if (callback) {
                        callback(err);
                    }
                    return;
                }

                _this.flush(callback);
            });
            return;
        }

        if (this.flushTimeoutID) {
            clearTimeout(this.flushTimeoutID);
            this.flushTimeoutID = null;
        }

        if (this.modified === false) {
            // No changes to flush...
            
            if (callback) {
                if (this.flushingDataHolder) {
                    // If there is a flush in progress then attach a
                    // listener to the current async data holder
                    this.flushingDataHolder.done(callback);
                }  else {
                    // Otherwise, no flush is happening and nothing to
                    // do so invoke callback immediately
                    callback();
                }
            }

            return;
        }

        logger.debug('flush() cache keys: ', Object.keys(this.cache));

        var flushingDataHolder;

        if (this.flushingDataHolder) {

            this.flushingDataHolder.done(function() {
                _this.flush(callback);
            });
            return;
        }

        this.modified = false;
        var encoding = this.encoding;
        
        flushingDataHolder = this.flushingDataHolder = new DataHolder();

        var finished = false;

        

        if (callback) {
            // If a callback was provided then attach a listener to the async flushing data holder
            flushingDataHolder.done(callback);
        }

        var cache = this.cache;

        // Now let's start actually writing the cache to disk...
        
        var tempFile = nodePath.join(this.dir, 'tmp' + uuid.v1());
        var file = this.file;

        var ended = false;


        var out = fs.createWriteStream(tempFile);

        function end() {
            if (ended) {
                return;
            }
            ended = true;
            out.end();
        }

        function done(err) {

            logger.debug('flush() - done. Error: ', err);
            if (finished) {
                return;
            }

            finished = true;

            end();

            if (err) {
                fs.unlink(tempFile, function() {});
                flushingDataHolder.reject(err);
            } else {
                flushingDataHolder.resolve();
            }

            _this.flushingDataHolder = null;

            // If there were writes after the flush was started 
            if (_this.writeAfterFlush) {
                _this.writeAfterFlush = false;
                scheduleFlush(_this);
            }
        }

        out.on('close', function() { // The flush is completed when the file is closed
            logger.debug('Flush completed to file ' + tempFile);
            
            // Delete the existing file if it exists
            fs.unlink(file, function() {
                fs.rename(tempFile, file, function(err) {
                    if (err) {
                        return done(err);
                    }

                    // Keep track that there is no longer a flush in progress
                    done();
                });
            });            
        });

        out.on('error', done);

        var keys = Object.keys(cache);
        var len = keys.length;
        var i = 0;
        var readyForNext = true;
        var bufferAvailable = true;
        var serialize = this.serialize;

        function writeUInt8(value) {
            var buffer = new Buffer(1);
            buffer.writeUInt8(value, 0);
            bufferAvailable = bufferAvailable && out.write(buffer);
        }

        writeUInt8(this.version);
        writeUInt8(this.mode);

        function writeBufferShort(buffer) {
            var len = buffer ? buffer.length : 0;
            var lenBuffer = new Buffer(2);
            lenBuffer.writeUInt16LE(len, 0);

            bufferAvailable = bufferAvailable && out.write(lenBuffer); // Write the length of the key as a 32bit unsigned integer (little endian)
            if (buffer) {
                bufferAvailable = bufferAvailable && out.write(buffer);    
            }
        }

        function writeBufferLong(buffer) {
            var lenBuffer = new Buffer(4);
            lenBuffer.writeUInt32LE(buffer.length, 0);

            bufferAvailable = bufferAvailable && out.write(lenBuffer); // Write the length of the key as a 32bit unsigned integer (little endian)
            bufferAvailable = bufferAvailable && out.write(buffer);
        }

        function writeInlineValue(key, cacheEntry) {
            var value = cacheEntry.value;

            if (value != null) {

                if (typeof value !== 'string' && !(value instanceof Buffer)) {
                    if (!serialize) {
                        throw new Error('Serializer is required for non-String/Buffer values');
                    }

                    value = serialize(value);
                }


                if (typeof value === 'string') {
                    value = new Buffer(value, encoding || 'utf8');
                }

                writeBufferLong(value);
            } else if (cacheEntry.reader) {
                readyForNext = false;

                var inStream = cacheEntry.reader();
                if (!inStream || typeof inStream.pipe !== 'function') {
                    throw new Error('Cache reader for key "' + key + '" did not return a stream');
                }

                var buffers = [];
                var totalLength = 0;

                inStream.on('error', done);

                inStream.pipe(through(function write(data) {
                        buffers.push(data); //data *must* not be null
                        totalLength += data.length;
                    },
                    function end () { //optional
                        var valueBuffer = Buffer.concat(buffers, totalLength);
                        writeBufferLong(valueBuffer);
                        readyForNext = true;
                        continueWriting();
                    }));

            } else {
                throw new Error('Illegal state');
            }
        }

        function writeExternalValue(key, cacheEntry) {

            if (cacheEntry.data.writeFileDataHolder) {
                logger.debug('writeExternalValue() - waiting for: ', key);
                readyForNext = false;
                // We are waiting for this entries value to be flushed to a separate file...
                cacheEntry.data.writeFileDataHolder.done(function(err, file) {
                    logger.debug('writeExternalValue() - done waiting for: ', key);

                    if (err) {
                        return done(err);
                    }

                    readyForNext = true;
                    continueWriting();
                });
            }
        }

        // This method is used to asynchronously write out cache entries to disk
        // NOTE: We did not make a copy of the cache so it is possible that some of the keys
        //       may no longer exist as we are flushing to disk, but that is okay since
        //       there is code to check if the key still exists in the cache
        function continueWriting() {
            logger.debug('continueWriting(), i:', i, len, 'bufferAvailable:', bufferAvailable, 'readyForNext:', readyForNext);

            if (i === len && readyForNext) {
                end();
                return;
            }

            // We'll be nice and keep writing to disk until the output file stream tells us that
            // it has no more buffer available. When that happens we wait for the drain event
            // to be fired before continuing writing where we left off.
            // NOTE: It is not mandatory to stop writing to the output stream when its buffer fills up (the bytes will be buffered by Node.js)
            while (i < len && bufferAvailable && readyForNext) {
                var key = keys[i];

                logger.debug('Writing ' + (i+1) + ' of ' + len, ' - key: ', key);

                if (!cache.hasOwnProperty(key)) {
                    i++;
                    // A cache entry may have been removed while flushing
                    continue;
                }

                

                var cacheEntry = cache[key];

                writeBufferShort(new Buffer(key, 'utf8'));

                var meta = cacheEntry.meta || {};

                if (!isObjectEmpty(meta)) {
                    writeBufferShort(new Buffer(JSON.stringify(meta), 'utf8'));
                } else {
                    writeBufferShort(0);
                }

                if (_this.mode === MODE_SINGLE_FILE) {
                    writeInlineValue(key, cacheEntry);
                } else {
                    writeExternalValue(key, cacheEntry);
                }

                i++;
            }

            if (i === len && readyForNext) {
                end();
            }
        }

        out.on('drain', function() {
            bufferAvailable = true;

            if (i < len && readyForNext) {
                continueWriting();
            }
        });

        continueWriting();
    }
};

module.exports = DiskStore;