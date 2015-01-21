var BigNumber = require('bignumber.js'),
    db = require('../db')

module.exports = function putRecords(store, data, cb) {

  var key = data.StreamName, metaDb = store.metaDb, streamDb = store.getStreamDb(data.StreamName)

  metaDb.lock(key, function(release) {
    cb = release(cb)

    store.getStream(data.StreamName, false, function(err, stream) {
      if (err) return cb(err)

      var batchOps = new Array(data.Records.length), returnRecords = new Array(data.Records.length),
        seqPieces = new Array(data.Records.length), record, hashKey, seqPiece

      for (var i = 0; i < data.Records.length; i++) {
        record = data.Records[i]

        if (record.ExplicitHashKey != null) {
          hashKey = BigNumber(record.ExplicitHashKey)

          if (hashKey.cmp(0) < 0 || hashKey.cmp(BigNumber(2).pow(128)) >= 0) {
            err = new Error
            err.statusCode = 400
            err.body = {
              __type: 'InvalidArgumentException',
              message: 'Invalid ExplicitHashKey. ExplicitHashKey must be in the range: [0, 2^128-1]. ' +
                'Specified value was ' + record.ExplicitHashKey,
            }
            return cb(err)
          }
        } else {
          hashKey = db.partitionKeyToHashKey(record.PartitionKey)
        }

        for (var j = 0; j < stream.Shards.length; j++) {
          if (hashKey.cmp(stream.Shards[j].HashKeyRange.StartingHashKey) >= 0 &&
              hashKey.cmp(stream.Shards[j].HashKeyRange.EndingHashKey) <= 0) {
            seqPieces[i] = {
              shardIx: j,
              shardId: stream.Shards[j].ShardId,
              streamCreateTime: db.parseSequence(
                stream.Shards[j].SequenceNumberRange.StartingSequenceNumber).streamCreateTime
            }
            break
          }
        }
      }

      // This appears to be the order that shards are processed in a PutRecords call
      var shardOrder = [4, 1, 0, 3, 2, 5, 7, 6, 9, 8]

      // Unsure of order after shard 9, just process sequentially
      for (i = 10; i < stream.Shards.length; i++) {
        shardOrder.push(i)
      }

      shardOrder.forEach(function(shardIx) {
        if (shardIx >= stream.Shards.length) return

        for (var i = 0; i < data.Records.length; i++) {
          record = data.Records[i]
          seqPiece = seqPieces[i]

          if (seqPiece.shardIx != shardIx) continue

          var seqIxIx = Math.floor(shardIx / 5)

          var seqNum = db.stringifySequence({
            streamCreateTime: seqPiece.streamCreateTime,
            shardIx: shardIx,
            seqIx: stream._seqIx[seqIxIx],
            seqTime: Date.now(),
          })

          stream._seqIx[seqIxIx]++

          batchOps[i] = {
            type: 'put',
            key: seqNum,
            value: {PartitionKey: record.PartitionKey, Data: record.Data},
          }

          returnRecords[i] = {ShardId: seqPiece.shardId, SequenceNumber: seqNum}
        }
      })

      metaDb.put(key, stream, function(err) {
        if (err) return cb(err)

        streamDb.batch(batchOps, {}, function(err) {
          if (err) return cb(err)
          cb(null, {FailedRecordCount: 0, Records: returnRecords})
        })
      })
    })
  })
}

