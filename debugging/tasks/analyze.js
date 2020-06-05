/*jshint globalstrict:false, strict:false, sub: true */
/*global ARGUMENTS, print, arango */
exports.name = "analyze";
exports.group= "analyze tasks";
exports.args = [
  { "name" : "agency-dump", "optional" : true, "type": "jsonfile", "description": "agency dump" }
];
exports.args_arangosh = "| --server.endpoint AGENT-OR-COORDINATOR";
exports.description = "Performs health analysis on your cluster and produces input files for other cleanup tasks.";
exports.selfTests = ["arango", "db"];
exports.requires = "3.3.23 - 3.7.99";
exports.info = `
Runs the analyze task against a cluster. It will create files and print
commands to fix some known problems like the removal of zombies or dead
primaries or creation of missing system collections.
`;

exports.run = function(extra, args) {
  // imports
  const fs = require('fs');
  const _ = require('lodash');
  const AsciiTable = require('../3rdParty/ascii-table');
  const helper = require('../helper.js');

  const printGood = helper.printGood;
  const printBad = helper.printBad;

  const parsedFile = helper.getValue("agency-dump", args);
  let response = helper.getAgencyDumpFromObjectOrAgency(parsedFile);
  let dump = response[0];
  let stores = response[1];

  const extractFailed = (info, dump) => {
    let failedInstanceEndpoints = [];
    const health = dump.arango.Supervision.Health;
    _.each(health, function (server, key) {
      if (server.Status === 'FAILED') {
        let endpoint = "";
        if (server.Endpoint.startsWith("ssl")) {
          endpoint = server.Endpoint.replace("ssl:", "https:");
        } else {
          endpoint = server.Endpoint.replace("tcp:", "http:");
        }
        failedInstanceEndpoints.push(endpoint);
      }
    });
    info.failedInstances = failedInstanceEndpoints;
  }

  const saveZombieCallbacks = function (info) {
    let zombieCallbacks = [];
    if (info.failedInstances.length > 0 && info.callbacks !== undefined) {
      Array.prototype.forEach.call(info.callbacks, callback => {
        let url = Object.keys(callback)[0];
        let fs  = url.indexOf("/");
        let end = url.indexOf("/", fs+2);
        if (info.failedInstances.includes(url.slice(0,end))) {
          zombieCallbacks.push(callback);
        }
      });
    }
    if (zombieCallbacks.length > 0) {
      fs.write("zombie-callbacks.json", JSON.stringify(zombieCallbacks));
      print(" To remedy the zombies callback issue please run the task `remove-zombie-callbacks` against the leader AGENT, e.g.:");
      print(` ./debugging/index.js <options> remove-zombie-callbacks ${fs.makeAbsolute('zombie-callbacks.json')}`);
      print();
    }
  };


  const zombieCoordinators = (info, dump) => {
    let plannedCoords = dump.arango.Plan.Coordinators;
    let currentCoords = dump.arango.Current.Coordinators;

    const health = dump.arango.Supervision.Health;
    var zombies = [];

    _.each(Object.keys(currentCoords), function (id) {
      if (!plannedCoords.hasOwnProperty(id)) {
        zombies.push(id);
      }
    });

    info.zombieCoordinators = zombies;
    if (zombies.length > 0) {
      return true;
    } else {
      return false;
    }

  };

  const printPrimaries = function (info) {
    var table = new AsciiTable('Primaries');
    table.setHeading('', 'status');

    _.each(info.primariesAll, function (server, name) {
      table.addRow(name, server.Status);
    });

    print(table.toString());
  };

  const printZombieCoordinators = function (info) {
    var haveZombies = info.zombieCoordinators.length > 0;
    if (!haveZombies) {
      printGood('Your cluster does not have any zombie coordinators');
      return false;
    } else {
      printBad('Your cluster has zombie coordinators');
      return true;
    }
  };

  const printCleanedFailoverCandidates = function (info) {
    var haveCleanedFailovers = (0 < Object.keys(info.correctFailoverCandidates).length);
    if (!haveCleanedFailovers) {
      printGood('Your cluster does not have any cleaned servers for failover');
      return false;
    } else {
      printBad('Your cluster has cleaned servers scheduled for failover');
      return true;
    }
  };

  const setGlobalShard = function (info, shard) {
    let dbServer = shard.dbServer;
    let isLeader = shard.isLeader;

    if (!info.shardsPrimary[dbServer]) {
      info.shardsPrimary[dbServer] = {
        leaders: [],
        followers: [],
        realLeaders: []
      };
    }

    if (isLeader) {
      info.shardsPrimary[dbServer].leaders.push(shard);

      if (shard.isReadLeader) {
        info.shardsPrimary[dbServer].realLeaders.push(shard);
      }
    } else {
      info.shardsPrimary[dbServer].followers.push(shard);
    }
  };

  const recursiveMapPrinter = (map) => {
    if (map instanceof Map) {
      const res = {};
      for (let [k,v] of map) {
        res[k] = recursiveMapPrinter(v);
      }
      return res;
    } else if (map instanceof Array) {
      return map.map(v => recursiveMapPrinter(v));
    } else if (map instanceof Object) {
      const res = {};
      for (let [k,v] of Object.entries(map)) {
        res[k] = recursiveMapPrinter(v);
      }
      return res;
    } else if (map instanceof Set) {
      const res = [];
      for (let v of map.values()) {
        res.push(recursiveMapPrinter(v));
      }
      return res;
    }
    return map;
  };

  const extractCollectionIntegrity = (info, dump) => {
    const planCollections = dump.arango.Plan.Collections;
    const planDBs = dump.arango.Plan.Databases;
    info.noPlanDatabases = [];
    info.noShardCollections = [];
    info.realLeaderMissing = [];
    info.leaderOnDeadServer = [];
    info.followerOnDeadServer = [];
    for (const [db, collections] of Object.entries(planCollections)) {
      if (!planDBs.hasOwnProperty(db)) {
        // This database has Collections but is deleted.
        info.noPlanDatabases.push(db, collections);
        continue;
      }
      for (const [name, col] of Object.entries(collections)) {
        const { shards, distributeShardsLike, isSmart } = col;
        if (!shards || (Object.keys(shards).length === 0 && !isSmart) || shards.constructor !== Object) {
          // We do not have shards
          info.noShardCollections.push({ db, name, col });
          continue;
        }

        if (distributeShardsLike && !collections.hasOwnProperty(distributeShardsLike)) {
          // The prototype is missing
          info.realLeaderMissing.push({ db, name, distributeShardsLike, col });
        }

        for (const [shard, servers] of Object.entries(shards)) {
          for (let i = 0; i < servers.length; ++i) {
            if (!info.primaries.hasOwnProperty(servers[i])) {
              if (i === 0) {
                info.leaderOnDeadServer.push({ db, name, shard, server: servers[i], servers });
              } else {
                info.followerOnDeadServer.push({ db, name, shard, server: servers[i], servers });
              }
            }
          }
        }
      }
    }
  };

  const extractDistributionGroups = (info, dump) => {
    const planCollections = dump.arango.Plan.Collections;
    const currentCollections = dump.arango.Current.Collections;
    /*
    * realLeaderCid => {
    *   plan => cid => [{ shard (sorted), servers: [Leader, F1, F2, F3] }],
    *   current => cid => [{ shard (sorted), servers: [Leader, F1, F2, F3] }],
    *   db = dbName
    * }
    */
    const shardGroups = new Map();
    // real leader cid
    const violatedDistShardLike = new Set();
    // {cid, shard, search}
    const noInsyncFollower = new Set();
    // {cid, shard, search}
    const unplannedLeader = new Set();
    // {cid, shard, search}
    const noInsyncAndDeadLeader = new Set();
    for (const [db, collections] of Object.entries(planCollections)) {
      for (const [cid, col] of Object.entries(collections)) {
        const { shards, distributeShardsLike } = col;
        if (!shards || Object.keys(shards).length === 0 || shards.constructor !== Object) {
          // We do not have shards
          continue;
        }
        // If we have DistLike we search for it, otherwise we are leader
        const search = distributeShardsLike || cid;
        const isNewEntry = !shardGroups.has(search);
        if (isNewEntry) {
          shardGroups.set(search, {
            plan: new Map(),
            current: new Map(),
            db
          });
        }
        // Every group is a object of
        // plan => cid => [{ shard (sorted), servers: [Leader, F1, F2, F3] }]
        // current => cid => [{ shard (sorted), servers: [Leader, F1, F2, F3] }]
        const group = shardGroups.get(search);
        const myPlan = [];
        const myCurrent = [];
        for (const [shard, servers] of Object.entries(shards)) {
          try {
            const curServers = currentCollections[db][cid][shard].servers;
            myPlan.push({shard, servers});
            myCurrent.push({shard, servers: curServers});
            if (curServers[0] !== servers[0]) {
              unplannedLeader.add({cid, shard, search});
            }
            if (servers.length > 1 && curServers.length <= 1) {
              noInsyncFollower.add({cid, shard, search});
              if (!info.primaries.hasOwnProperty(curServers[0])) {
                noInsyncAndDeadLeader.add({cid, shard, search});
              }
            }
          } catch (e) {}
        }

        myPlan.sort((l, r) => l.shard > r.shard);
        myCurrent.sort((l, r) => l.shard > r.shard);

        if (!isNewEntry) {
          // Pick any of the existing, they need to be all equal, or at least one needs to be reported
          const comp = group.plan.values().next().value;
          for (let i = 0; i < comp.length; ++i) {
            if (comp[i] !== myPlan[i]) {
              // We have at least one mismatch of plans that violate distribution
              violatedDistShardLike.add(search);
              break;
            }
          }
        }
        group.plan.set(cid, myPlan);
        group.current.set(cid, myCurrent);
      }
    }

    info.shardGroups = shardGroups;
    info.violatedDistShardLike = violatedDistShardLike;
    info.noInsyncFollower = noInsyncFollower;
    info.unplannedLeader = unplannedLeader;
    info.noInsyncAndDeadLeader = noInsyncAndDeadLeader;
  };

  const printDistributionGroups = (info) => {
    const { noInsyncAndDeadLeader } = info;
    let infected = false;
    if (noInsyncAndDeadLeader && noInsyncAndDeadLeader.size > 0) {
      printBad('Your cluster has collections with dead leader and no insync follower');

      const table = new AsciiTable('Collections with deadLeader and no-insync Follower');
      table.setHeading('CID', 'Shard', 'DistributeLike');
      for (const {cid, shard, search} of noInsyncAndDeadLeader) {
        table.addRow(cid, shard, search);
      }
      print(table.toString());
      infected = true;
    } else {
      printGood('Your cluster does not have any collections with dead leader and no insync follower');
    }
    return infected;
  };

  const saveDistributionGroups = (info) => {
    const { noInsyncAndDeadLeader, shardGroups, primaries } = info;
    if (noInsyncAndDeadLeader && noInsyncAndDeadLeader.size > 0) {
      const clonedGroups = new Map();
      for (const {cid, shard, search} of noInsyncAndDeadLeader) {
        // candidates: server => [insyncShard]
        const candidates = new Map();

        const group = shardGroups.get(search);
        const myPlan = group.plan.get(cid);
        const shardIndex = myPlan.findIndex(s => s.shard === shard);
        const allShards = [];
        for (const s of myPlan[shardIndex].servers) {
          if (primaries.hasOwnProperty(s)) {
            // This primary is alive, let us check
            candidates.set(s, []);
          }
        }
        // Iterate over all current distributions on shardIndex, and if we find an insync follower
        // note it to the candidates
        for (const [cid, curServers] of group.current) {
          const { shard, servers} = curServers[shardIndex];
          allShards.push(shard);
          for (const [c, list] of candidates) {
            if (servers.indexOf(c) !== -1) {
              list.push(shard);
            }
          }
        }

        const sortedCandidates = [...candidates.entries()].sort((l, r) => l[1].length > r[1].length);
        print("List of potential failover candidates, first has most in sync:");
        for (const [c, list] of sortedCandidates) {
          const missing = _.without(allShards, ...list);
          print(`Failover to ${c} insync: ${JSON.stringify(list)}, please check state of ${JSON.stringify(missing)}`);
          print("If you want to failover to this server run the `force-forceover` task against the leader AGENT, e.g.:");
          print(` ./debugging/index.js <options> force-failover ${fs.makeAbsolute('forceFailover.json')} ${c} ${search} ${shardIndex}`);
        }
        clonedGroups.set(search, shardGroups.get(search));
      }
      fs.write("forceFailover.json", JSON.stringify(recursiveMapPrinter(clonedGroups)));
    }
  };

  const printCollectionIntegrity = (info) => {
    const {
      noPlanDatabases,
      noShardCollections,
      realLeaderMissing,
      leaderOnDeadServer,
      followerOnDeadServer
    } = info;
    let infected = false;
    if (noPlanDatabases.length > 0) {
      printBad('Your cluster has some leftover collections from deleted databases');
      const table = new AsciiTable('Deleted databases with leftover collections');
      table.setHeading('Database');
      for (const d of noPlanDatabases) {
        table.addRow(d);
      }
      print(table.toString());
      infected = true;
    } else {
      printGood('Your cluster does not have any leftover collections from deleted databases');
    }

    if (noShardCollections.length > 0) {
      printBad('Your cluster has some collections without shards');
      const table = new AsciiTable('Collections without shards');
      table.setHeading('Database', 'CID');
      for (const d of noShardCollections) {
        table.addRow(d.db, d.name);
      }
      print(table.toString());
      infected = true;
    } else {
      printGood('Your cluster does not have any collections without shards');
    }

    if (realLeaderMissing.length > 0) {
      printBad('Your cluster misses some collection(s) used as leaders in distributeShardsLike');
      const table = new AsciiTable('Real leader missing for collection');
      table.setHeading('Database', 'CID', 'LeaderCID');
      for (const d of realLeaderMissing) {
        table.addRow(d.db, d.name, d.distributeShardsLike);
      }
      print(table.toString());
      infected = true;
    } else {
      printGood('Your cluster does not miss any collections used as leaders in distributeShardsLike');
    }

    if (leaderOnDeadServer.length > 0) {
      printBad('Your cluster has leaders placed on failed DBServers');
      const table = new AsciiTable('Leader on failed DBServer');
      table.setHeading('Database', 'CID', 'Shard', 'Failed DBServer', 'All Servers');
      for (const d of leaderOnDeadServer) {
        table.addRow(d.db, d.name, d.shard, d.server, JSON.stringify(d.servers));
      }
      print(table.toString());
      infected = true;
    } else {
      printGood('Your cluster does not have any leaders placed on failed DBServers');
    }

    if (followerOnDeadServer.length > 0) {
      printBad('Your cluster has followers placed on failed DBServers');
      const table = new AsciiTable('Follower on failed DBServer');
      table.setHeading('Database', 'CID', 'Shard', 'Failed DBServer', 'All Servers');
      for (const d of followerOnDeadServer) {
        table.addRow(d.db, d.name, d.shard, d.server, JSON.stringify(d.servers));
      }
      print(table.toString());
      infected = true;
    } else {
      printGood('Your cluster does not have any followers placed on failed DBServers');
    }
    return infected;
  };

  const saveCollectionIntegrity = (info) => {
    const {
      noPlanDatabases,
      noShardCollections,
      realLeaderMissing,
      leaderOnDeadServer,
      followerOnDeadServer
    } = info;
    if (noPlanDatabases.length > 0 ||
      noShardCollections.length > 0 ||
      realLeaderMissing.length > 0 ||
      leaderOnDeadServer.length > 0 ||
      followerOnDeadServer.length > 0) {
      fs.write("collectionIntegrity.json", JSON.stringify({
        noPlanDatabases,
        noShardCollections,
        realLeaderMissing,
        leaderOnDeadServer,
        followerOnDeadServer
      }));
    }
  };

  const printDatabases = function (info) {
    var table = new AsciiTable('Databases');
    table.setHeading('', 'collections', 'shards', 'leaders', 'followers', 'Real-Leaders');

    _.each(_.sortBy(info.databases, x => x.name), function (database, name) {
      table.addRow(database.name, database.collections.length, database.shards.length,
        database.leaders.length, database.followers.length,
        database.realLeaders.length);
    });

    print(table.toString());
    return false;
  };

  const printCollections = function (info) {
    var table = new AsciiTable('collections');
    table.setHeading('', 'CID', 'RF', 'Shards Like', 'Shards', 'Type', 'Smart');

    _.each(_.sortBy(info.collections, x => x.fullName), function (collection, name) {
      table.addRow(collection.fullName, collection.id, collection.replicationFactor,
        collection.distributeShardsLike, collection.numberOfShards,
        collection.type, collection.isSmart);
    });
    print(table.toString());
    return false;
  };

  const printPrimaryShards = function (info) {
    var table = new AsciiTable('Primary Shards');
    table.setHeading('', 'Leaders', 'Followers', 'Real Leaders');

    _.each(info.shardsPrimary, function (shards, dbServer) {
      table.addRow(dbServer, shards.leaders.length, shards.followers.length, shards.realLeaders.length);
    });

    print(table.toString());
    return false;
  };

  const printZombies = function (info) {
    if (0 < info.zombies.length) {
      printBad('Your cluster has some zombies');
      var table = new AsciiTable('Zombies');
      table.setHeading('Database', 'CID');

      _.each(info.zombies, function (zombie) {
        table.addRow(zombie.database, zombie.cid);
      });

      print(table.toString());
      return true;
    } else {
      printGood('Your cluster does not have any zombies');
      return false;
    }
  };

  const saveZombies = function (info) {
    if (info.zombies.length > 0) {
      let output = [];

      _.each(info.zombies, function (zombie) {
        output.push({ database: zombie.database, cid: zombie.cid, data: zombie.data });
      });

      fs.write("zombies.json", JSON.stringify(output));
      print("To remedy the zombies issue please run the task `remove-zombies` against the leader AGENT, e.g.:");
      print(` ./debugging/index.js <options> remove-zombies ${fs.makeAbsolute('zombies.json')}`);
      print();
    }
  };

  const saveZombieCoords = function (info) {
    if (info.zombieCoordinators.length > 0) {
      fs.write("zombie-coordinators.json", JSON.stringify(info.zombieCoordinators));
      print("To remedy the zombie coordinators issue please run the task `remove-zombie-coordinators` against the leader AGENT, e.g.:");
      print(` ./debugging/index.js <options> remove-zombie-coordinators ${fs.makeAbsolute('zombie-coordinators.json')}`);
      print();
    }
  };

  const saveCleanedFailoverCandidates = function (info) {
    if (0 < Object.keys(info.correctFailoverCandidates).length) {
      fs.write("cleaned-failovers.json", JSON.stringify(info.correctFailoverCandidates));
      print("To remedy the cleaned out failover db servers issue please run the task `remove-cleaned-failovers` against the leader AGENT, e.g.:");
      print(` ./debugging/index.js <options> remove-cleaned-failovers ${fs.makeAbsolute('cleaned-failovers.json')}`);
      print();
    }
  };

  const printBroken = function (info) {
    if (0 < info.broken.length) {
      printBad('Your cluster has broken collections');
      var table = new AsciiTable('Broken');
      table.setHeading('Database', 'CID');

      _.each(info.broken, function (zombie) {
        table.addRow(zombie.database, zombie.cid);
      });

      print(table.toString());
      return true;
    } else {
      printGood('Your cluster does not have broken collections');
      return false;
    }
  };

  const extractCurrentDatabasesDeadPrimaries = (info, dump) => {
    let databases = [];

    _.each(dump.arango.Current.Databases, function (database, name) {
      _.each(database, function (primary, pname) {
        if (!info.primaries.hasOwnProperty(pname)) {
          databases.push({
            database: name,
            primary: pname,
            data: primary
          });
        }
      });
    });

    info.databasesDeadPrimaries = databases;
  };

  const printCurrentDatabasesDeadPrimaries = function (info) {
    if (0 < info.databasesDeadPrimaries.length) {
      printBad('Your cluster has dead primaries in Current');
      var table = new AsciiTable('Dead primaries in Current');
      table.setHeading('Database', 'Primary');

      _.each(info.databasesDeadPrimaries, function (zombie) {
        table.addRow(zombie.database, zombie.primary);
      });

      print(table.toString());
      return true;
    } else {
      printGood('Your cluster does not have any dead primaries in Current');
      return false;
    }
  };

  const saveCurrentDatabasesDeadPrimaries = function (info) {
    if (info.databasesDeadPrimaries.length > 0) {
      let output = [];

      _.each(info.databasesDeadPrimaries, function (zombie) {
        output.push({ database: zombie.database, primary: zombie.primary, data: zombie.data });
      });

      fs.write("dead-primaries.json", JSON.stringify(output));
      print("To remedy the dead primaries issue please run the task `remove-dead-primaries` against the leader AGENT, e.g.:");
      print(` ./debugging/index.js <options> remove-dead-primaries ${fs.makeAbsolute('dead-primaries.json')}`);
      print();
    }
  };

  const extractEmptyDatabases = function (info) {
    info.emptyDatabases = [];
    _.each(_.sortBy(info.databases, x => x.name), function (database, name) {
      if (database.collections.length === 0 && database.shards.length === 0) {
        info.emptyDatabases.push(database);
      }
    });
  };

  const printEmptyDatabases = function (info) {
    if (0 < info.emptyDatabases.length) {
      printBad('Your cluster has some skeleton databases (databases without collections)');
      var table = new AsciiTable('Skeletons');
      table.setHeading('Database name');

      _.each(info.emptyDatabases, function (database) {
        table.addRow(database.name);
      });

      print(table.toString());
      return true;
    } else {
      printGood('Your cluster does not have any skeleton databases (databases without collections)');
      return false;
    }
  };

  const saveEmptyDatabases = function (info) {
    if (info.emptyDatabases.length > 0) {
      let output = [];

      _.each(info.emptyDatabases, function (skeleton) {
        output.push({ database: skeleton.name, data: skeleton.data });
      });

      fs.write("skeleton-databases.json", JSON.stringify(output));
      print("To remedy the skeleton databases issue please run the task `remove-skeleton-databases` against the leader AGENT, e.g.:");
      print(` ./debugging/index.js <options> remove-skeleton-databases ${fs.makeAbsolute('skeleton-databases.json')}`);
      print();
    }
  };

  const extractMissingCollections = function (info) {
    info.missingCollections = [];

    _.each(_.sortBy(info.databases, x => x.name), function (database, name) {
      let system = database.collections.filter(function (c) {
        return c.name[0] === '_';
      }).map(function(c) {
        return c.name;
      });

      let missing = [];
      [ "_apps", "_appbundles", "_aqlfunctions", "_graphs", "_jobs", "_queues" ].forEach(function(name) {
        if (system.indexOf(name) === -1) {
          missing.push(name);
        }
      });

      if (missing.length > 0) {
        info.missingCollections.push({ database: database.name, missing });
      }
    });
  };

  const printMissingCollections = function (info) {
    if (info.missingCollections.length > 0) {
      printBad('Your cluster is missing relevant system collections:');
      var table = new AsciiTable('Missing collections');
      table.setHeading('Database', 'Collections');

      _.each(info.missingCollections, function (entry) {
        table.addRow(entry.database, entry.missing.join(", "));
      });

      print(table.toString());
      return true;
    } else {
      printGood('Your cluster is not missing relevant system collections');
      return false;
    }
  };

  const saveMissingCollections = function (info) {
    if (info.missingCollections.length > 0) {
      let output = info.missingCollections;

      fs.write("missing-collections.json", JSON.stringify(output));
      print("To remedy the missing collections issue please run the task " +
            "`create-missing-collections` AGAINST A COORDINATOR, e.g.:");
      print(` ./debugging/index.js <options> create-missing-collections ${fs.makeAbsolute('missing-collections.json')}`);
      print();
    }
  };

  const extractCleanedFailoverCandidates = (info, dump) => {
    const currentCollections = dump.arango.Current.Collections;
    const cleanedServers = dump.arango.Target.CleanedServers;
    var fixes = {};
    Object.keys(currentCollections).forEach(function (dbname) {
      var database = dump.arango.Current.Collections[dbname];
      Object.keys(database).forEach(function(colname) {
        var collection = database[colname];
        Object.keys(collection).forEach(function(shname) {
          var shard = collection[shname];
          var inter = _.intersectionWith(cleanedServers, shard.failoverCandidates);
          var left = shard.failoverCandidates;
          left = _.difference(left, inter);
          if (inter.length > 0) {
            fixes["arango/Current/Collections/"+ dbname +"/"+ colname +"/"+ shname +
                  "/failoverCandidates"]
              = [left, shard.failoverCandidates];
          }
        });
      });
    });
    info.correctFailoverCandidates = fixes;
  };

  const extractOutOfSyncFollowers = (info, dump) => {
    const planCollections = dump.arango.Plan.Collections;
    const currentCollections = dump.arango.Current.Collections;
    const compareFollowers = (plan, current) => {
      // If leaders are not equal we are out of sync.
      if(plan[0] !== current[0]) {
        return false;
      }
      if (plan.length === 1) {
        // we have not even requested a follower
        return true;
      }
      for (let i = 1; i < plan.length; ++i) {
        const other = current.indexOf(plan[i]);
        if (other < 1) {
          return false;
        }
      }
      return true;
    };
    info.outOfSyncFollowers = [];
    for (const [db, collections] of Object.entries(planCollections)) {
      if (!currentCollections.hasOwnProperty(db)) {
        // database skeleton or  so, don't care
        continue;
      }
      for (const [name, col] of Object.entries(collections)) {
        const { shards } = col;
        if (!shards || Object.keys(shards).length === 0) {
          continue;
        }
        for (const [shard, servers] of Object.entries(shards)) {
          try {
            const current = currentCollections[db][name][shard].servers;
            if (!compareFollowers(servers, current)) {
              info.outOfSyncFollowers.push({
                db, name, shard, servers, current
              });
            }
          } catch (e) {}
        }
      }
    }
  };

  const printOutOfSyncFollowers = (info) => {
    const { outOfSyncFollowers } = info;
    const counters = new Map();
    if (outOfSyncFollowers.length > 0) {
      printBad('Your cluster has collections where followers are out of sync');
      {
        const table = new AsciiTable('Out of sync followers');
        table.setHeading('Database', 'CID', 'Shard', 'Planned', 'Real');
        for (const oosFollower of outOfSyncFollowers) {
          table.addRow(oosFollower.db, oosFollower.name, oosFollower.shard, oosFollower.servers, oosFollower.current);
          counters.set(oosFollower.servers[0], (counters.get(oosFollower.servers[0]) || 0) + 1);
        }
        print(table.toString());
      }
      {
        const table = new AsciiTable('Number of non-replicated shards per server');
        table.setHeading('Server', 'Number');
        for (const [server, number] of counters.entries()) {
          table.addRow(server, number);
        }
        print(table.toString());
      }
      return true;
    } else {
      printGood('Your cluster does not have collections where followers are out of sync');
      return false;
    }
  };

  const extractBrokenEdgeIndexes = (info, dump) => {
    info.brokenEdgeIndexes = [];
    const planCollections = dump.arango.Plan.Collections;
    for (const [db, collections] of Object.entries(planCollections)) {
      for (const [name, col] of Object.entries(collections)) {
        const { indexes } = col;
        if (!indexes || Object.keys(indexes).length === 0) {
          continue;
        }
        let failed = false;
        let newIndexes = [];
        for (const [pos, index] of Object.entries(indexes)) {
          if (index.type === "edge" &&
              index.name === "edge" &&
              index.id === "1" &&
              index.fields.length > 1) {
            failed = true;
          }

          if (index.id === "1") {
            newIndexes.push({
              "id": "1", 
              "type": "edge", 
              "name": "edge", 
              "fields": [ "_from" ], 
              "unique": false, 
              "sparse": false 
            });
            newIndexes.push({
              "id": "2", 
              "type": "edge", 
              "name": "edge", 
              "fields": [ "_to" ], 
              "unique" : false, 
              "sparse" : false 
            });
          } else if (index.id !== "2") {
            newIndexes.push(index);
          }
        }
        if (failed) {
          info.brokenEdgeIndexes.push({
            path: "/Plan/Collections/" + db + "/" + name + "/indexes",
            bad: indexes,
            good: newIndexes
          });
        }
      }
    }
  };

  const printBrokenEdgeIndexes = (info) => {
    const { brokenEdgeIndexes } = info;
    if (brokenEdgeIndexes.length > 0) {
      printBad('Your cluster has broken edge indexes');
      return true;
    } else {
      printGood('Your cluster does not have broken edge indexes');
      return false;
    }
  };

  const saveBrokenEdgeIndexes = function (info) {
    const { brokenEdgeIndexes } = info;
    if (brokenEdgeIndexes.length > 0) {
      fs.write("broken-edge-indexes.json", JSON.stringify(brokenEdgeIndexes));
      print("To remedy the broken-edge-index issue please run the task " +
            "`repair-broken-edge-indexes` AGAINST A COORDINATOR, e.g.:");
      print(` ./debugging/index.js <options> repair-broken-edge-indexes ${fs.makeAbsolute('broken-edge-indexes.json')}`);
      print();
    }
  };

  const info = {};

  if (stores !== undefined) {
    info.callbacks = stores.read_db[2];
  }

  // extract info
  extractFailed(info, dump);
  helper.extractPrimaries(info, dump);
  helper.extractDatabases(info, dump);
  zombieCoordinators(info, dump);
  extractCollectionIntegrity(info, dump);
  extractCurrentDatabasesDeadPrimaries(info, dump);
  extractDistributionGroups(info, dump);
  extractEmptyDatabases(info);
  extractMissingCollections(info);
  extractOutOfSyncFollowers(info, dump);
  extractCleanedFailoverCandidates(info, dump);
  extractBrokenEdgeIndexes(info, dump);

  let infected = false;

  // Print funny tables
  infected = printPrimaries(info) || infected;
  print();
  infected = printDatabases(info) || infected;
  print();
  infected = printCollections(info) || infected;
  print();
  infected = printPrimaryShards(info) || infected;
  print();

  infected = printZombies(info) || infected;
  infected = printZombieCoordinators(info) || infected;
  infected = printCleanedFailoverCandidates(info) || infected
  infected = printBroken(info) || infected;
  infected = printCollectionIntegrity(info) || infected;
  infected = printCurrentDatabasesDeadPrimaries(info) || infected;
  infected = printEmptyDatabases(info) || infected;
  infected = printMissingCollections(info) || infected;
  infected = printOutOfSyncFollowers(info) || infected;
  infected = printDistributionGroups(info) || infected;
  infected = printBrokenEdgeIndexes(info) || infected;
  print();

  if (infected) {
    // Save to files
    saveCollectionIntegrity(info);
    saveZombies(info);
    saveZombieCoords(info);
    saveCurrentDatabasesDeadPrimaries(info);
    saveDistributionGroups(info);
    saveEmptyDatabases(info);
    saveMissingCollections(info);
    saveCleanedFailoverCandidates(info);
    saveBrokenEdgeIndexes(info);
  } else {
    printGood('Did not detect any issues in your cluster');
  }

  saveZombieCallbacks(info, stores);
};
