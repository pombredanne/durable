exports = module.exports  = durable = function () {
    var MongoClient = require("mongodb").MongoClient;
    var ObjectId = require("mongodb").ObjectID;
    var express = require("express");

    var session = function (document, messages, sessions, db) {
        var that = document;
        var input = {};
        var output = {};
        var state = {};
        var postMessages = [];
        var insertSessions = [];
        var using = false;

        that.getInput = function () {
            return input;
        }

        that.setInput = function (newInput) {
            input = newInput;
            input.$visited = false;
        }

        that.getOutput = function () {
            return output;
        }

        that.setOutput = function (newOutput) {
            output = newOutput;
            output.$visited = false;
        }

        that.getState = function () {
            return state;
        }

        that.setState = function (newState) {
            state = newState;
        }

        that.inUse = function () {
            return using;
        }

        that.use = function () {
            using = true;
        }

        that.receive = function (query, projection, complete) {
            if (!complete) {
                throw "complete function must be provided";
            }

            if (!query.session) {
                query.session = that.id;
            }

            messages.find(query, { fields: { _id: 0 } }).nextObject(function (err, result) {
                if (err) {
                    complete("error: couldn't get message, details:" + err);
                }
                else if (!result) {
                    complete(null, null);
                }
                else {
                    if (!that.receivedMessages) {
                        that.receivedMessages = {};
                    }

                    //this check will avoid returning the same message twice
                    //thus ensuring exactly once delivery
                    if (that.receivedMessages[result.id]) {
                        //bug: need to fix the query, this will cycle forever
                        complete(null, null);
                    }
                    else {
                        that.receivedMessages[result.id] = { id: result.id, count: 0 };
                        complete(null, result);
                    }
                }
            });
        }

        that.idle = function (complete) {
            if (!complete) {
                throw "complete function must be provided";
            }

            sessions.update({ id: that.id, status: "active" }, { $set: { status: "idle" } }, function (err, result) {
                that.status = "idle";
                if (err) {
                    complete("Could not idle session, details:" + err);
                }
                else {
                    complete();
                }
            });
        }

        that.suspend = function (suspendReason, complete) {
            if (!complete) {
                throw "complete function must be provided";
            }

            sessions.update({ id: that.id, $or: [{ status: "active" }, { status: "idle" }] }, { $set: { status: "suspended", reason: suspendReason } }, function (err, result) {
                that.status = "suspended";
                if (err) {
                    complete("Could not suspend session, details:" + err);
                }
                else {
                    complete();
                }
            });
        }

        that.complete = function (complete) {
            if (!complete) {
                throw "complete function must be provided";
            }

            sessions.update({ id: that.id, $or: [{ status: "active" }, { status: "idle" }] }, { $set: { status: "complete" } }, function (err, result) {
                that.status = "complete";
                if (err) {
                    complete("Could not complete session, details" + err);
                }
                else {
                    if (that.id.lastIndexOf('.') === -1) {
                        complete();
                    }
                    else {
                        if (that.id.lastIndexOf('[') !== -1 &&
                            that.id.lastIndexOf('[0]') === -1) {
                            complete();
                        }
                        else {
                            var messageId = new Date().getTime();
                            messages.update({ id: messageId }, { id: messageId, session: that.id, signal: "complete", effective: new Date().getTime() }, { upsert: true }, function (err, result) {
                                if (err) {
                                    complete("error: could not insert message, details: " + err);
                                }
                                else {
                                    complete();
                                }
                            })
                        };
                    }
                }
            });
        }

        that.post = function (message) {
			if (!message.effective) {
                message.effective = new Date().getTime();
            }
			
			if (message.id && message.id.toString) {
				message.id = message.id.toString();
			}
			
			if (message.session && message.session.toString) {
				message.session = message.session.toString();
			}
			
            postMessages.push(message);
        }

        that.fork = function (subId, theirDocument) {
            theirDocument.id = that.id + "." + subId;
            theirDocument.status = "idle";
            insertSessions.push(theirDocument);
        }

        that.join = function (subId, resolve, complete) {
            if (!complete) {
                throw "complete function must be provided";
            }

            sessions.find({ id: that.id + "." + subId, status: "complete" }).nextObject(function (err, result) {
                if (err || !result) {
                    complete("error: could not find completed session:" + that.id + "." + subId + ", details: " + err);
                }
                else {
                    resolve(that, result);
                    complete();
                }
            });
        }

        that.map = function (subId, mapFunc) {
            var subSessions = mapFunc(that);
            for (var sessionIndex = 0; sessionIndex < subSessions.length; ++sessionIndex) {
                var subSession = subSessions[sessionIndex];
                that.fork(subId + "[" + sessionIndex + "]", subSession);
            }
        }

        that.reduce = function (subId, reduceFunc, resolve, complete) {
            if (!complete) {
                throw "complete function must be provided";
            }

            sessions.find({ id: eval("/" + that.id + "." + subId + "\\[/"), $or: [{ status: "active" }, { status: "idle" }] }).nextObject(function (err, result) {
                if (err) {
                    complete("error: could not run query, details: " + err);
                }
                if (result) {
                    complete();
                }
                else {
                    sessions.find({ id: eval("/" + that.id + "." + subId + "\\[/"), status: "complete" }).toArray(function (err, result) {
                        if (err || !result.length) {
                            complete("error: could not find completed sessions for:" + that.id + "." + subId + ", details: " + err);
                        }
                        else {
                            var resultSessions = [];
                            for (var index = 0; index < result.length; ++index) {
                                resultSessions.push(session(result[index], messages, sessions, db));
                            }

                            resolve(that, reduceFunc(resultSessions));
                            complete(null, true);
                        }
                    });
                }
            });
        }

        var postAll = function (complete) {            
            if (!postMessages.length) {
                complete();
            }
            else {
                var message = postMessages[0];
                postMessages.splice(0, 1);
                var toMessages;
                if (message.promise) {
                    toMessages = db.collection(message.promise + "Messages");
                }
                else {
                    toMessages = messages;
                }
                delete (message.$visited);
				if (!message.session) {
					message.session = that.id;
				}
						
                toMessages.update({ id: message.id, session: message.session }, message, { upsert: true }, function (err, result) {
                    if (err) {
                        complete("error: could not insert message, details: " + err);
                    }
                    else {
						var toSessions;
						if (message.promise) {
                            toSessions = db.collection(message.promise + "Sessions");
                        }
                        else {
                            toSessions = sessions;
                        }
						
						var sessionId;
						if (message.session.indexOf('.') !== -1) {
							sessionId = message.session.substring(0, message.session.indexOf('.'));
						}
						else {
							sessionId = message.session;
						}

						toSessions.update({ id: sessionId }, { $set: { id: sessionId } }, { upsert: true }, function (err, result) {
							if (err) {
								complete("error: could not find or add session, details: " + err);
							}
							else {
								toSessions.update({ id: sessionId, status: { $exists: false } }, { $set: { status: "idle" } }, function (err, result) {
									if (err) {
										complete("error: could not update session, details: " + err);
									} else {
										postAll(complete);
									}
								});
							}
						});					                        
                    }
                });
            }
        }

        that.checkpoint = function (complete) {
            if (!complete) {
                throw "complete function must be provided";
            }

            //Find current active record Id. Considerations:
            //1. If there is a failure we don't want to loose the active session.                
            //2. If the session has been cancelled or suspended, we don't want to proceed.
            sessions.find({ id: that.id, status: "active" }, { _id: 1 }).nextObject(function (err, result) {
                if (err || !result) {
                    complete("error: couldn't find active session record for: " + that.id + ", details:" + err);
                }
                else {
                    var oldId = result._id;
                    //the send operation could happen more than once if there is a failure after send
                    postAll(function (err) {
                        if (err) {
                            complete(err);
                        }
                        else {
                            //remove old records of messages received
                            if (that.receivedMessages) {
                                for (var id in that.receivedMessages) {
                                    var retry = that.receivedMessages[id];
                                    if (retry.count < 2) {
                                        retry.count = retry.count + 1;
                                    }
                                    else {
                                        delete that.receivedMessages[id];
                                    }
                                }
                            }

                            insertSessions.push(that);
                            //if node crashed after insert, but before update, there could be two active records
                            sessions.insert(insertSessions, function (err, result) {
                                if (err) {
                                    complete("error: couldn't insert session records, details" + err);
                                }
                                else {
                                    sessions.update({ _id: oldId }, { $set: { status: "checked" }, $unset: { tag: "" } }, function (err, result) {
                                        //ignore error, ophnaned session records are cleaned up in the background    
                                        //remove messages already received
                                        var messagesQuery = [];
                                        for (var messageId in that.receivedMessages) {
                                            messagesQuery.push({ id: that.receivedMessages[messageId].id, session: that.id });
                                        }
                                        if (!messagesQuery.length) {
                                            complete();
                                        }
                                        else {											
                                            messages.remove({ $or: messagesQuery }, function (err, result) {
                                                if (err) {
                                                    complete("error: couldn't remove received messages, details" + err);
                                                }
                                                else {
                                                    complete();
                                                }
                                            });
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            });
        }

        return that;
    }

    var dispatcher = function (func) {
        that = {};

        that.run = function (session, complete) {
            func(session, complete);
        }

        that.register = function (definitionName) {
            if (!promiseContainer) {
                throw "Server has not been prepared";
            }

            promiseContainer.patchPromise(definitionName, that, function (err) { });
        }

        return that;
    }

    var promise = function (func, name, async, context) {
        var that = dispatcher();
        var directory = { root: that };
        var next;
        if (name) {
            directory[name] = that;
        }

        that.getName = function () {
            return name;
        }

        that.getNext = function () {
            return next;
        }

        that.getRoot = function () {
            return directory["root"];
        }

        that.getDirectory = function () {
            return directory;
        }

        that.setDirectory = function (value) {
            if (directory !== value) {
                directory = value;
                if (name) {
                    if (directory[name]) {
                        if (directory[name] !== that) {
                            throw "name already registered " + name;
                        }
                    }

                    directory[name] = that;
                }
                if (next) {
                    next.setDirectory(value);
                }
            }
        }

        that.continueWith = function (nextPromise, nextName, nextContext) {
            if (typeof (nextPromise) === "function") {
                next = promise(nextPromise, nextName, false, nextContext);
                next.setDirectory(directory);
                return next;
            }
            else {
                next = nextPromise.getRoot();
                next.setDirectory(directory);
                return nextPromise;
            }
        }

        that.setNext = function (nextPromise) {
            next = nextPromise;
        }

        that.run = function (session, complete) {
            //console.log("running type " + that.type + " name " + that.getName());        
            if (!session.label && !session.inUse()) {
                session.use();
                directory["root"].run(session, complete);
            }
            else if (!session.inUse()) {
                if (directory[session.label]) {
                    currentPromise = directory[session.label];
                    session.use();
                    currentPromise.run(session, complete);
                }
                else {
                    complete("Could not find matching label " + session.label + " in promise " + name);
                }
            }
            else {
                if (!session.getInput().$visited) {
                    session.getInput().$visited = true;
                }
                else {
                    session.setInput({});
                }

                if (!session.getOutput().$visited) {
                    session.getOutput().$visited = true;
                }
                else {
                    session.setOutput({});
                }

                if (!async) {
                    var suspended;
                    try {
                        func(session, context);
                    }
                    catch (reason) {
                        complete(reason);
                        session.suspend(reason, complete);
                        suspended = true;
                    }

                    if (!suspended) {
                        if (next) {
                            next.run(session, complete);
                        }
                        else {
                            session.complete(function (session) { });
                        }
                    }
                }
                else {
                    try {
                        func(session, function (err) {
                            if (err) {
                                complete(err);
                                //session.suspend(err, complete);
                            }
                            else {
                                if (next) {
                                    next.run(session, complete);
                                }
                                else if (session.status === "active") {
                                    session.complete(function (session) { });
                                }
                            }
                        }, context);
                    }
                    catch (reason) {
                        complete(reason);
                        session.suspend(reason, complete);
                    }
                }
            }
        }

        that.checkpoint = function (checkpointName) {
            return that.continueWith(checkpoint(checkpointName));
        }

        that.idle = function () {
            return that.continueWith(idle());
        }

        that.suspend = function () {
            return that.continueWith(suspend());
        }

        that.delay = function (interval, delayName) {
            return that.continueWith(delay(interval, delayName));
        }

        that.mapReduce = function (mapFunc, streamPromise, reduceFunc, mapName) {
            return that.continueWith(mapReduce(mapFunc, streamPromise, reduceFunc, mapName));
        }

        that.receive = function (query, projection) {
            return that.continueWith(receive(query, projection));
        }

        that.post = function () {
            return that.continueWith(post());
        }

        that.startTimer = function (interval, timerName) {
            return that.continueWith(startTimer(interval, timerName));
        }

        that.waitAllEvents = function (events) {
            return that.continueWith(waitEvents(events, true));
        }

        that.waitAnyEvent = function (events) {
            return that.continueWith(waitEvents(events, false));
        }

        that.waitAllStreams = function (streams, waitName, mergePolicy) {
            return that.continueWith(waitStreams(streams, true, waitName, mergePolicy));
        }

        that.waitAnyStream = function (streams, waitName, mergePolicy) {
            return that.continueWith(waitStreams(streams, false, waitName, mergePolicy));
        }

        that.toJSON = function () {
            if (!next) {
                return [that];
            }
            else {
                var nextArray = next.toJSON();
                nextArray.push(that);
                return nextArray;
            }
        }

        that.type = "promise";
        that.params = { func: func.toString(), name: name, async: async, context: context };
        return that;
    }

    var branch = function (condition, name) {
        var elseAction;

        var setDirectory = function (value) {
            superSetDirectory(value);
            if (elseAction) {
                elseAction.setDirectory(value);
            }
        }

        var elseContinue = function (action, elseName, elseContext) {
            if (typeof (action) === "function") {
                elseAction = promise(action, elseName, false, elseContext);
                elseAction.setDirectory(that.getDirectory());
                return elseAction;
            }
            else {
                elseAction = action.getRoot();
                elseAction.setDirectory(that.getDirectory());
                return action;
            }
        }

        var setElse = function (action) {
            elseAction = action;
        }

        var execute = function (session, complete) {
            session.getOutput().$visited = false;
            if (session.getOutput().checked) {
                complete();
            }
            else {
                elseAction.run(session, complete);
            }
        }

        var that = promise(execute, null, true);
        var superSetDirectory = that.setDirectory;
        that.setDirectory = setDirectory;
        that.elseContinue = elseContinue;
        that.setElse = setElse;
        that.type = "branch";
        condition.continueWith(that);
        return that;
    }

    var idle = function () {

        var execute = function (session, complete) {
            session.idle(complete);
        }

        var that = promise(execute, null, true);
        that.type = "idle";
        that.params = {};
        return that;
    }

    var suspend = function (reason) {

        var execute = function (session, complete) {
            reason = reason || session.getInput();
            session.suspend(reason, complete);
        }

        var that = promise(execute, null, true);
        that.type = "suspend";
        that.params = { reason: reason };
        return that;
    }

    var tryCondition = function (func, name, context) {

        var execute = function (session, context) {
            session.getOutput().$visited = false;

            if (func(session, context)) {
                session.getOutput().checked = true;
            }
            else {
                session.getOutput().checked = false;
            }
        }

        var that = promise(execute, name, false, context);
        that.type = "tryCondition";
        that.params = { func: func.toString(), name: name, context: context };
        return that;
    }

    var tryEvents = function (events, all) {

        var resolve = function (eventName, events) {
            var event = events[eventName];
            var setInput = function (session, promiseContext) {
                var previousInput = session.getState().$input;
                if (promiseContext.indexOf('$') === -1) {
                    session.setInput(previousInput[promiseContext] || {});
                }
                else {
                    promiseContext = promiseContext.substring(0, promiseContext.indexOf('$'));
                    session.setInput(previousInput[promiseContext] || {});
                    session.getState().$input = previousInput[promiseContext] || {};
                }
            }

            if (eventName.indexOf("$and") !== -1) {
                return promise(setInput, null, false, eventName).continueWith(and(event));
            }
            else if (eventName.indexOf("$or") !== -1) {
                return promise(setInput, null, false, eventName).continueWith(or(event));
            }
            else {
                if (event.getRoot().toJSON) {
                    events[eventName] = event.getRoot().toJSON();
                }
                else {
                    events[eventName] = event.getRoot();
                }

                return promise(setInput, null, false, eventName).continueWith(event);
            }
        }

        var firstFunction = function (session) {
            session.getState().$input = session.getInput();
            session.getState().$output = {};
        }

        var lastFunction = function (session) {
            session.setOutput(session.getState().$output);
            session.getState().$output = {};
        }

        var noFunction = function (session) {
            session.getState().$output.checked = false;
        }

        var yesFunction = function (session, promiseContext) {
            session.getState().$output[promiseContext] = session.getOutput();
            session.getState().$output.checked = true;
        }

        var and = function (events) {
            var that = promise(lastFunction);
            var currentAndPromise;
            for (var andEventName in events) {
                if (!currentAndPromise) {
                    currentAndPromise = promise(firstFunction).continueWith(branch(resolve(andEventName, events)));
                }
                else {
                    currentAndPromise = currentAndPromise.continueWith(branch(resolve(andEventName, events)));
                }

                if (andEventName.indexOf("$") !== -1) {
                    andEventName = andEventName.substring(0, andEventName.indexOf("$"));
                }


                currentAndPromise.elseContinue(noFunction).setNext(that);
                currentAndPromise = currentAndPromise.continueWith(yesFunction, null, andEventName);
            }
            currentAndPromise.continueWith(that);

            that.type = "and";
            return that;
        }

        var or = function (events) {
            var that = promise(lastFunction);
            var currentOrPromise;
            for (var orEventName in events) {
                if (!currentOrPromise) {
                    currentOrPromise = promise(firstFunction).continueWith(branch(resolve(orEventName, events)));
                }
                else {
                    currentOrPromise = currentOrPromise.elseContinue(branch(resolve(orEventName, events)));
                }

                if (orEventName.indexOf("$") !== -1) {
                    orEventName = orEventName.substring(0, orEventName.indexOf("$"));
                }

                currentOrPromise.continueWith(yesFunction, null, orEventName).setNext(that);
            }
            currentOrPromise.elseContinue(noFunction).continueWith(that);

            that.type = "or";
            return that;
        }

        if (all) {
            return and(events);
        }
        else {
            return or(events);
        }
    }

    var waitEvents = function (events, all) {
        var condition = branch(tryEvents(events, all));
        condition.elseContinue(idle());
        condition.getRoot().toJSON = function () {
            if (!condition.getNext()) {
                return [{ type: "waitEvents", params: { events: events, all: all } }];
            }
            else {
                var nextArray = condition.getNext().toJSON();
                nextArray.push({ type: "waitEvents", params: { events: events, all: all } });
                return nextArray;
            }
        }

        return condition;
    }

    var waitAnyEvent = function (events) {
        return waitEvents(events, false);
    }

    var waitAllEvents = function (events) {
        return waitEvents(events, true);
    }

    var stateChart = function (chart, parentStateName, parentStateRoot) {
        var that;
        if (parentStateName) {
            parentStateName = parentStateName + ".";
        }
        else {
            parentStateName = "";
        }

        var resolveEvent = function (transition) {
            if (transition.when) {
                return transition.when;
            }
            else if (transition.whenAny) {
                return tryEvents(transition.whenAny);
            }
            else if (transition.whenAll) {
                return tryEvents(transition.whenAll, true);
            }
            else {
                return promise(function (session) {
                    session.setOutput({ checked: true });
                });
            }
        }

        var createTransitions = function (state, transitions) {
            var rootStatePromise;
            var lastPromise;
            for (transitionName in state) {
                if (transitionName != "$chart") {
                    var currentTransition = state[transitionName];
                    if (!rootStatePromise) {
                        rootStatePromise = branch(resolveEvent(currentTransition));
                    }
                    else {
                        rootStatePromise = rootStatePromise.elseContinue(branch(resolveEvent(currentTransition)));
                    }

                    if (currentTransition.run) {
                        if (typeof (currentTransition.run) === "function") {
                            currentTransition.run = promise(currentTransition.run);
                        }

                        var runPromise = currentTransition.run;
                        if (currentTransition.run.getRoot().toJSON) {
                            currentTransition.run = currentTransition.run.getRoot().toJSON();
                        }
                        else {
                            currentTransition.run = currentTransition.run.getRoot();
                        }

                        lastPromise = rootStatePromise.continueWith(runPromise);
                    }
                    else {
                        lastPromise = rootStatePromise;
                    }

                    if (!currentTransition.to) {
                        throw "transition " + transitionName + " doesn't have to";
                    }

                    transitions.push({ to: parentStateName + currentTransition.to, promise: lastPromise });
                }
            }

            if (!rootStatePromise) {
                return null;
            }
            else {
                if (parentStateRoot) {
                    rootStatePromise.setElse(parentStateRoot);
                    parentStateRoot.setDirectory(rootStatePromise.getDirectory());
                }
                else {                    
                    rootStatePromise.elseContinue(idle());
                }
                return rootStatePromise;
            }
        }

        var stateTable = {};
        var transitionList = [];
        for (var stateName in chart) {
            var currentState = chart[stateName];
            var statePromise = createTransitions(currentState, transitionList);
            var stableStateName = parentStateName + stateName;
            
            if (currentState.$chart) {
                var childChart = stateChart(currentState.$chart, stateName, statePromise.getRoot());
                statePromise = checkpoint(stableStateName).continueWith(childChart).getRoot();
            }
            else {
                if (!statePromise) {
                    statePromise = checkpoint(stableStateName);
                    transitionList.push({ to: "$end", promise: statePromise });
                }
                else if (!currentState.$chart) {
                    statePromise = checkpoint(stableStateName).continueWith(statePromise).getRoot();
                }
            }

            stateTable[stableStateName] = statePromise;
        }

		var nextState;
        for (var i = 0; i < transitionList.length; ++i) {
            var stateTransition = transitionList[i];
            if (stateTransition.to === "$end") {
				if (!that) {
					that = promise(function (session) { }, "$end");
				}
				
                stateTransition.promise.setNext(that);
                if (!stateTransition.promise.getDirectory()["$end"]) {
                    that.setDirectory(stateTransition.promise.getDirectory());
                }
            }
            else {
                nextState = stateTable[stateTransition.to];
                if (!nextState) {
                    throw "State " + stateTransition.to + " does not exist";
                }

                stateTransition.promise.setNext(nextState);
                nextState.setDirectory(stateTransition.promise.getDirectory());
            }
        }
		
        if (parentStateRoot) {
            return parentStateRoot;
        }
        else {
			if (!that) {
				throw "error: no final state found";
			}
			
            that.getRoot().toJSON = function () {
                if (!that.getNext()) {
                    return [{ type: "stateChart", params: { chart: chart } }];
                }
                else {
                    var nextArray = that.getNext().toJSON();
                    nextArray.push({ type: "stateChart", params: { chart: chart } });
                    return nextArray;
                }
            }

            return that;
        }
    }

    var flowChart = function (chart) {
        var that;

        var createTransitions = function (stageName, transitions) {
            var stage = chart[stageName];
            if (!stage.to) {
                stage.to = "$end";
            }

            var currentStagePromise;
            if (!stage.run) {
                currentStagePromise = checkpoint(stageName);
            }
            else {
                if (typeof (stage.run) == "function") {
                    stage.run = promise(stage.run);
                }

                var runPromise = stage.run;
                if (stage.run.getRoot().toJSON) {
                    stage.run = stage.run.getRoot().toJSON();
                }
                else {
                    stage.run = stage.run.getRoot();
                }

                currentStagePromise = checkpoint(stageName).continueWith(runPromise);
            }

            if (typeof (stage.to) === "string") {
                transitions.push({ to: stage.to, promise: currentStagePromise });
            }
            else {
                var first = true;
                for (var currentStageName in stage.to) {
                    stage.to[currentStageName] = tryCondition(stage.to[currentStageName]);
                    if (first) {
                        currentStagePromise = currentStagePromise.continueWith(branch(stage.to[currentStageName]));
                        first = false;
                    }
                    else {
                        currentStagePromise = currentStagePromise.elseContinue(branch(stage.to[currentStageName]));
                    }

                    transitions.push({ to: currentStageName, promise: currentStagePromise });
                }

                currentStagePromise.elseContinue(suspend("Could not resolve next stage"));
            }

            return currentStagePromise.getRoot();
        }

        var stageTable = {};
        var transitionList = [];
        for (var currentStageName in chart) {
            stageTable[currentStageName] = createTransitions(currentStageName, transitionList);
        }

        var stageTransition;
        for (var i = 0; i < transitionList.length; ++i) {
            var stageTransition = transitionList[i];
            if (stageTransition.to === "$end") {
				if (!that) {
					that = promise(function (session) { }, "$end");
				}
				
                stageTransition.promise.setNext(that);
                if (!stageTransition.promise.getDirectory()["$end"]) {
                    that.setDirectory(stageTransition.promise.getDirectory());
                }
            }
            else {
                var nextStage = stageTable[stageTransition.to];
                if (!nextStage) {
                    throw "Stage " + stageTransition.to + " does not exist";
                }

                stageTransition.promise.setNext(nextStage);
                nextStage.setDirectory(stageTransition.promise.getDirectory());
            }
        }

		if (!that) {
			throw "error: no final stage found";
		}
		
        that.getRoot().toJSON = function () {
            if (!that.getNext()) {
                return [{ type: "flowChart", params: { chart: chart } }];
            }
            else {
                var nextArray = that.getNext().toJSON();
                nextArray.push({ type: "flowChart", params: { chart: chart } });
                return nextArray;
            }
        }

        return that;
    }

    var startStreams = function (streams, name) {
        var that;

        var startStream = function (streamPromise, name) {

            var setDirectory = function (value) {
                superSetDirectory(value);
                if (streamPromise) {
                    streamPromise.setDirectory(value);
                }
            }

            var copy = function (object) {
                var newObject = {};
                for (var pName in object) {
                    propertyType = typeof (object[pName]);
                    if (propertyType !== "function") {
                        if (propertyType === "object") {
                            newObject[pName] = copy(object[pName]);
                        }
                        else {
                            newObject[pName] = object[pName];
                        }
                    }
                }

                return newObject;
            }

            var execute = function (session, complete) {
                name = name || session.getInput().streamName;

                if (session.label === name) {
                    streamPromise.run(session, function (err) { });
                }
                else {
                    var subSession = copy(session);
                    subSession.label = name;
                    session.fork(name, subSession);
                    complete();
                }
            }

            var that = promise(execute, name, true);
            var superSetDirectory = that.setDirectory;
            that.setDirectory = setDirectory;
            that.type = "startStream";
            return that;
        }

        for (var streamName in streams) {
            var currentStream = streams[streamName].getRoot();
            if (currentStream.toJSON) {
                streams[streamName] = currentStream.toJSON();
            }
            else {
                streams[streamName] = currentStream;
            }

            if (!that) {
                that = startStream(currentStream, streamName);
            }
            else {
                that = that.continueWith(startStream(currentStream, streamName));
            }
        }

        return that;
    }

    function yours(oldSession, newSession) {
    }

    function theirs(oldSession, newSession) {
        var name;
        for (name in oldSession) {
            if (typeof (oldSession[name] !== "function")) {
                delete oldSession.name;
            }
        }

        for (name in newSession) {
            oldSession[name] = newSession[name];
        }
    }

    function merge(conflict) {

        var compare = function (path, oldObject, newObject) {
            for (var name in newObject) {
                propertyType = typeof (newObject[name]);
                if (propertyType !== "function" && name !== "id" && name !== "status") {
                    if (!oldObject[name]) {
                        oldObject[name] = newObject[name];
                    }
                    else if (oldObject[name] != newObject[name]) {
                        if (path != "") {
                            path = path + "\\";
                        }

                        if (propertyType === "object") {
                            oldObject[name] = compare(path + name, oldObject[name], newObject[name]);
                        }
                        else {
                            if (conflict) {
                                oldObject[name] = conflict(path + name, oldObject[name], newObject[name]);
                            }
                            else {
                                oldObject[name] = newObject[name];
                            }
                        }
                    }
                }
            }

            return oldObject;
        }

        return function (oldSession, newSession) {
            return compare("", oldSession, newSession);
        }
    }

    var tryJoinStreams = function (streams, mergePolicy, all) {
        var tryJoin = function (streamName, mergePolicy) {
            var policy = mergePolicy || merge();

            var execute = function (session, complete) {
                var sessionId = session.id + "." + streamName;
                session.receive({ session: sessionId, signal: "complete" }, null, function (err, message) {
                    if (err) {
                        if (complete) {
                            complete(err);
                        }
                    }
                    else {
                        if (!message) {
                            session.setOutput({ checked: false });
                            console.log("no output");
                            complete();
                        }
                        else {
                            session.setOutput({ checked: true });
                            session.join(streamName, policy, complete);
                        }
                    }
                });
            }

            var that = promise(execute, null, true);
            return that;
        }

        var joinEvent = {};
        for (var streamName in streams) {
            joinEvent[streamName] = tryJoin(streamName, mergePolicy);
        }

        return tryEvents(joinEvent, all);
    }

    var waitStreams = function (streams, all, name, mergePolicy) {
        var condition = branch(tryJoinStreams(streams, mergePolicy, all));
        condition.elseContinue(idle());
        startStreams(streams).checkpoint(name).continueWith(condition);

        condition.getRoot().toJSON = function () {
            if (!condition.getNext()) {
                return [{ type: "waitStreams", params: { streams: streams, name: name, all: all } }];
            }
            else {
                var nextArray = condition.getNext().toJSON();
                nextArray.push({ type: "waitStreams", params: { streams: streams, name: name, all: all } });
                return nextArray;
            }
        }

        return condition;
    }

    var waitAnyStream = function (streams, name, mergePolicy) {
        return waitStreams(streams, false, name, mergePolicy);
    }

    var waitAllStreams = function (streams, name, mergePolicy) {
        return waitStreams(streams, true, name, mergePolicy);
    }

    var map = function (mapFunc, streamPromise, name) {
        streamPromise = streamPromise.getRoot();

        var setDirectory = function (value) {
            superSetDirectory(value);
            if (streamPromise) {
                streamPromise.setDirectory(value);
            }
        }

        var execute = function (session, complete) {
            if (session.label === name) {
                streamPromise.run(session, function (err) { });
            }
            else {
                session.map(name, function (session) {
                    var sessions = mapFunc(session);
                    for (sessionIndex = 0; sessionIndex < sessions.length; ++sessionIndex) {
                        sessions[sessionIndex].label = name;
                    }

                    return sessions;
                });
                complete();
            }

        }

        var that = promise(execute, name, true);
        var superSetDirectory = that.setDirectory;
        that.setDirectory = setDirectory;
        that.type = "map";
        return that;
    }

    var tryReduce = function (reduceFunc, mapName) {

        var execute = function (session, complete) {
            session.reduce(mapName, reduceFunc, theirs, function (err, result) {
                if (err) {
                    if (complete) {
                        complete(err);
                    }
                }
                else {
                    if (!result) {
                        session.setOutput({ checked: false });
                    }
                    else {
                        session.setOutput({ checked: true });
                    }

                    complete();
                }
            });
        }

        var that = promise(execute, null, true);
        that.type = "tryReduce";
        return that;
    }

    var mapReduce = function (mapFunc, streamPromise, reduceFunc, name) {
        var condition = branch(tryReduce(reduceFunc, name));
        condition.elseContinue(idle());
        return map(mapFunc, streamPromise, name).checkpoint("$" + name).continueWith(condition);
    }

    var post = function () {

        var execute = function (session, complete) {
            var message = session.getInput();
            session.post(message);
        }

        var that = promise(execute);
        that.type = "post";
        that.params = {};
        return that;
    }

    var tryReceive = function (query, projection) {
        var query = query || {};

        var execute = function (session, complete) {
            var receiveQuery = query;
            var receiveProjection = projection;
            if (session.getInput().query) {
                receiveQuery = session.getInput().query;
            }

            if (session.getInput().projection) {
                receiveProjection = session.getInput().projection;
            }
            session.receive(receiveQuery, receiveProjection, function (err, message) {
                if (err) {
                    if (complete) {
                        complete(err);
                    }
                }
                else {
                    if (!message) {
                        session.setOutput({ checked: false });
                    }
                    else {
                        message.checked = true;
                        session.setOutput(message);
                    }

                    complete();
                }
            });

        }

        that = promise(execute, null, true);
        that.type = "tryReceive";
        that.params = { query: query, projection: projection };
        return that;
    }

    var receive = function (query, projection) {
        var condition = branch(tryReceive(query, projection));
        condition.elseContinue(idle());

        condition.getRoot().toJSON = function () {
            if (!condition.getNext()) {
                return [{ type: "receive", params: { query: query, projection: projection } }];
            }
            else {
                var nextArray = condition.getNext().toJSON();
                nextArray.push({ type: "receive", params: { query: query, projection: projection } });
                return nextArray;
            }
        }

        return condition;
    }

    var startTimer = function (interval, timerName) {
        var that = promise(function (session) {
            if (session.getInput().interval) {
                interval = session.getInput().interval;
            }

            var nextDate = new Date();
            nextDate.setSeconds(nextDate.getSeconds() + interval);
            var newMessage = {
                effective: nextDate.getTime(),
                id: timerName,
                session: session.id
            }
            session.setInput(newMessage);
        })
        .post();

        that.getRoot().toJSON = function () {
            if (!that.getNext()) {
                return [{ type: "startTimer", params: { timerName: timerName, interval: interval } }];
            }
            else {
                var nextArray = that.getNext().toJSON();
                nextArray.push({ type: "startTimer", params: { timerName: timerName, interval: interval } });
                return nextArray;
            }
        }

        return that;
    }

    var tryTimer = function (timerName) {
        var that = promise(function (session) {
            session.setInput({ query: { effective: { $lt: new Date().getTime() }, id: timerName } });
        })
        .continueWith(tryReceive());

        that.getRoot().toJSON = function () {
            if (!that.getNext()) {
                return [{ type: "tryTimer", params: { timerName: timerName } }];
            }
            else {
                var nextArray = that.getNext().toJSON();
                nextArray.push({ type: "tryTimer", params: { timerName: timerName } });
                return nextArray;
            }
        }

        return that;
    }

    var delay = function (interval, name) {
        var condition = branch(tryTimer(name));
        condition.elseContinue(idle());
        startTimer(interval, name)
        .checkpoint(name)
        .continueWith(condition);

        condition.getRoot().toJSON = function () {
            if (!condition.getNext()) {
                return [{ type: "delay", params: { name: name, interval: interval } }];
            }
            else {
                var nextArray = condition.getNext().toJSON();
                nextArray.push({ type: "delay", params: { name: name, interval: interval } });
                return nextArray;
            }
        }

        return condition;
    }

    var checkpoint = function (name) {

        var execute = function (session, complete) {
            if (session.label === name) {
				session.label = "";
                if (complete) {
                    complete();
                }
            }
            else {
                session.label = name;
                session.checkpoint(function (err) {
                    if (!that.getNext()) {
                        session.complete(complete);
                    }
                    else if (err) {
                        complete(err);
                    }
                    else {
                        session.idle(function (err) { if (err) (complete(err)); });
                    }
                });
            }
        }

        var that = promise(execute, name, true);
        that.params = { name: name };
        that.type = "checkpoint";
        return that;
    }

    var container = function (database) {
        var that = {};
        var database = database || "mongodb://localhost:27017/promisesDb";
        var cachedPromises = [];
        var batch = 5;
        var db;

        that.getSessions = function (promiseName, query, skip, top, complete) {
            var sessions = db.collection(promiseName + "Sessions");
            var aggregateParams = [];
            if (skip) {
                aggregateParams.push({ $skip: skip });
            }

            if (top) {
                aggregateParams.push({ $limit: top });
            }

            if (!query) {
                aggregateParams.push({ $match: { status: { $ne: "checked" } } });
            }
            else {
                query.status = { $ne: "checked" };
                aggregateParams.push({ $match: query });
            }

            sessions.aggregate(aggregateParams, function (err, result) {
                if (err) {
                    complete("error: could not run query, details: " + err);
                }
                else {
                    for (var i = 0; i < result.length; ++i) {
                        delete (result[i].receivedMessages);
                    }

                    complete(null, result);
                }
            });        
        }

        that.getHistory = function (promiseName, sessionId, query, skip, top, complete) {
            var sessions = db.collection(promiseName + "Sessions");
            var aggregateParams = [];
            if (skip) {
                aggregateParams.push({ $skip: skip });
            }

            if (top) {
                aggregateParams.push({ $limit: top });
            }

            if (!query) {
                aggregateParams.push({ $match: { id: sessionId } });
            }
            else {
                query.id = sessionId;
                if (query._id) {
                    if (query._id.$gt) {
                        query._id = { $gt: ObjectId(query._id.$gt) };
                    }
                }

                aggregateParams.push({ $match: query });

            }

            sessions.aggregate(aggregateParams, function (err, result) {
                if (err) {
                    complete("error: could not find session:" + sessionId + ", details: " + err);
                }
                else {
                    for (var i = 0; i < result.length; ++i) {
                        delete (result[i].receivedMessages);
                    }

                    complete(null, result);
                }
            });
        }

        that.getStatus = function (promiseName, sessionId, complete) {
            var sessions = db.collection(promiseName + "Sessions");
            sessions.find({ id: sessionId, status: { $ne: "checked" } }).nextObject(function (err, result) {
                if (err || !result) {
                    complete("error: could not find session:" + sessionId + ", details: " + err);
                }
                else {
                    delete (result.receivedMessages);
                    complete(null, result);
                }
            });               
        }

        that.patchSession = function (promiseName, document, complete) {
            var sessions = db.collection(promiseName + "Sessions");
            var tag = new Date().getTime();
            sessions.update({ id: document.id, $or: [{ status: "idle" }, { status: "suspended" }, { status: "complete" }] }, { $set: { status: "active", tag: tag } }, function (err, result) {
                if (err || !result) {
                    complete("Could not update session, details:" + err);
                }

                document.status = "idle";
                sessions.insert(document, function (err, result) {
                    if (err) {
                        complete("Could not insert session, details:" + err);
                    }
                    else {
                        sessions.update({ tag: tag }, { $set: { status: "checked" }, $unset: { tag: "" } }, function (err, result) {
                            if (err) {
                                complete("Could not update session, details:" + err);
                            }
                            else {
                                complete();
                            }
                        });
                    }
                });
            });               
        }

        that.suspendSession = function (promiseName, sessionId, suspendReason, complete) {
            var sessions = db.collection(promiseName + "Sessions");
            sessions.update({ id: document.id, $or: [{ status: "active" }, { status: "idle" }] }, { $set: { status: "suspended", reason: suspendReason } }, function (err, result) {
                if (err) {
                    complete("Could not update session, details:" + err);
                }
                else {
                    complete();
                }
            });                
        }

        that.patchPromise = function (promiseName, promise, complete) {
            var json;
            if (promise.toJSON) {
                json = promise.toJSON();
            }
            else {
                json = promise;
            }

            cachedPromises[promiseName] = promise;
            var promiseDefinition = { name: promiseName, code: json };
            var promiseDefinitions = db.collection("promiseDefinitions");
            promiseDefinitions.update({ name: promiseName }, promiseDefinition, { upsert: true }, function (err, result) {
                if (err) {
                    complete(error = "error: could not register or update promise, details: " + err)
                }
                else {

                    complete();
                }
            });               
        }

        that.getPromise = function (promiseName, complete) {
            var promiseDefinitions = db.collection("promiseDefinitions");
            promiseDefinitions.find({ name: promiseName }).nextObject(function (err, result) {
                if (err || !result) {
                    complete("error: couldn't access promise information for " + promiseName);
                }
                else {
                    complete(null, result.code);
                }
            });               
        }

        var postTo = function (message, complete) {
            var messages = db.collection(message.promise + "Messages");
			messages.ensureIndex("session", function(err, result){});
			messages.ensureIndex("effective", function(err, result){});
            if (!message.effective) {
                message.effective = new Date().getTime();
            }

			if (message.id.toString) {
				message.id = message.id.toString();
			}
			
			if (message.session.toString) {
				message.session = message.session.toString();
			}
			
            messages.update({ id: message.id, session: message.session }, message, { upsert: true }, function (err, result) {
                if (err) {
                    complete("error: could not insert message, details: " + err);
                }
                else {
                    var sessions = db.collection(message.promise + "Sessions");
					var sessionId;
                    if (message.session.indexOf('.') !== -1) {
                        sessionId = message.session.substring(0, message.session.indexOf('.'));
                    }
                    else {
                        sessionId = message.session;
                    }

                    sessions.update({ id: sessionId }, { $set: { id: sessionId } }, { upsert: true }, function (err, result) {
                        if (err) {
                            complete("error: could not find or add session, details: " + err);
                        }
                        else {
                            sessions.update({ id: sessionId, status: { $exists: false } }, { $set: { status: "idle" } }, function (err, result) {
                                if (err) {
                                    complete("error: could not update session, details: " + err);
                                } else {
                                    complete();
                                }
                            });
                        }
                    });
                }
            });
        }

        that.post = function (message, complete) {
            if (!message.id) {
				complete("error: no message id provided");
			}
			else if (!message.session) {
				complete("error: no message session provided");
			}
			else {
				var promiseDefinitions = db.collection("promiseDefinitions");
				promiseDefinitions.find({ name: message.promise }).nextObject(function (err, result) {
					if (err || !result) {
						complete("error: couldn't access promise information for " + message.promise);
					}

					postTo(message, complete);
				});   
			}
        }

        var dispatchPromise = function (promiseName, complete) {
            db.command({ distinct: promiseName + "Messages", key: "session", query: { effective: { $lt: new Date().getTime() } } }, function (err, result) {
                if (!result.values.length) {
                    complete();
                }
                else {
                    var sessions = db.collection(promiseName + "Sessions");
					sessions.ensureIndex("id", function(err, result){});
					sessions.ensureIndex("status", function(err, result){});
                    var sessionQuery = [];
                    for (var i = 0; i < result.values.length; ++i) {
                        var sessionId = result.values[i];
                        sessionQuery.push({ id: sessionId });
                        while (sessionId.lastIndexOf('.') !== -1) {
                            sessionId = sessionId.substring(0, sessionId.lastIndexOf('.'));
                            sessionQuery.push({ id: sessionId });
                        }
                    }

                    var tag = Math.floor(Math.random()*1000000);
                    sessions.update({ status: "idle", $or: sessionQuery }, { $set: { status: "active", tag: tag } }, { multi: true }, function (err, result) {
                        if (err) {
                            complete("error: could not update sessions");
                        }
                        else if (!result) {
                            complete();
                        }
                        else {
                            sessions.find({ status: "active", tag: tag, $or: sessionQuery }, { fields: { _id: 0 } }).each(function (err, result) {
                                if (err) {
                                    complete("error: could not iterate cursor");
                                }
                                if (!result) {
                                    complete();
                                }
                                else {
                                    delete result.tag;
                                    var runningSession = session(result, db.collection(promiseName + "Messages"), sessions, db);
                                    var promise = cachedPromises[promiseName];
                                    if (promise) {
                                        promise.run(runningSession, function (err) {
                                            complete(err);
                                        });
                                    }
                                    else {
                                        var promiseDefinitions = db.collection("promiseDefinitions");
                                        promiseDefinitions.find({ name: promiseName }).nextObject(function (err, result) {
                                            if (err || !result) {
                                                complete("error: could not find promise " + promiseName);
                                            }
                                            else {
                                                promise = eval(result.code);
                                                cachedPromises[promiseName] = promise;
                                                promise.run(runningSession, function (err) {
                                                    complete(err);
                                                });
                                            }
                                        });
                                    }
                                }
                            });
                        }
                    });
                }
            });
        }

        var enumarateResults = function (results, index, complete) {
            if (index >= results.length) {
                complete();
            }
            else {
                dispatchPromise(results[index].name, function (err) {
                    if (err) {
                        complete(err);
                    }
                    else {
                        enumarateResults(results, index + 1, complete);
                    }
                });
            }
        }

        that.dispatch = function (complete) {                        
            var control = db.collection("control");
            control.findAndModify({ promiseIndex: { $gt: 0 } }, { promiseIndex: 1 }, { $inc: { promiseIndex: batch } }, { upsert: true }, function (err, result) {
                if (err || !result) {
                    complete("error: could not find index");
                }
                else {
                    var promiseIndex = result.promiseIndex;
                    db.collection("promiseDefinitions").count(function (err, result) {
                        if (err) {
                            complete("error: could not find promiseDefinitions");
                        }
                        else {
                            var startIndex = promiseIndex % result;
                            var length = startIndex + batch >= result ? result - startIndex : batch;

                            db.collection("promiseDefinitions").aggregate([{ $skip: startIndex }, { $limit: length }], function (err, result) {
                                if (result) {
                                    enumarateResults(result, 0, complete);
                                }
                            });
                        }
                    });
                }
            });                            
        }

        that.run = function (port, basePath, callback) {
            port = port || 5000;
            basePath = basePath || "";
            var app = express.createServer();
            app.use(express.bodyParser());

            var stat = require("node-static");
            var fileServer = new stat.Server(__dirname);
            
			app.get(basePath + "/durableVisual.js", function (request, response) {
                request.addListener("end", function () {
                    fileServer.serveFile("/durableVisual.js", 200, {}, request, response);
                }).resume();
            });
			
            app.get(basePath + "/:promise/:session/admin.html", function (request, response) {
                request.addListener("end", function () {
                    fileServer.serveFile("/admin.html", 200, {}, request, response);
                }).resume();
            });

            app.get(basePath + "/:promise/:session/history", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                var top;
                var skip;
                var query;
                if (request.query.$top) {
                    top = parseInt(request.query.$top);
                }

                if (request.query.$skip) {
                    skip = parseInt(request.query.$skip);
                }

                if (request.query.$filter) {
                    try {
                        query = JSON.parse(request.query.$filter);
                    }
                    catch (reason) {
                        response.send({ error: "Invalid Query" }, 500);
                        return;
                    }
                }

                that.getHistory(request.params.promise,
                request.params.session,
                query,
                skip,
                top,
                function (err, result) {
                    if (err) {
                        response.send({ error: err }, 500);
                    }
                    else {
                        response.send(result);
                    }
                });
            });

            app.get(basePath + "/:promise/:session", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                that.getStatus(request.params.promise,
                request.params.session,
                function (err, result) {
                    if (err) {
                        response.send({ error: err }, 500);
                    }
                    else {
                        response.send(result);
                    }
                });
            });

            app.post(basePath + "/:promise/:session", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                var message = request.body;
                message.promise = request.params.promise;
                message.session = request.params.session;
                that.post(message, function (err) {
					if (err)
						response.send({ error: err }, 500);
					else
						response.send();
				});                
            });

            app.patch(basePath + "/:promise/:session", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                document = request.body;
                var promise = request.params.promise;
                document.id = request.params.session;
                that.patchSession(promise, document, function (err) {
                    if (err)
                        response.send({ error: err }, 500);
                    else
                        response.send();
                });
            });

            app.delete(basePath + "/:promise/:session", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                var reason = request.body;
                var promise = request.params.promise;
                var sessionId = request.params.session;
                that.suspendSession(promise, sessionId, reason, function (err) {
                    if (err)
                        response.send({ error: err }, 500);
                    else
                        response.send();
                });
            });

            app.patch(basePath + "/:promise", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                var promise = request.params.promise;
                var code = request.body;
                that.patchPromise(promise, code, function (err) {
                    if (err)
                        response.send({ error: err }, 500);
                    else
                        response.send();
                });
            });

            app.get(basePath + "/:promise", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                var promise = request.params.promise;
                that.getPromise(promise, function (err, result) {
                    if (err) {
                        response.send({ error: err }, 500);
                    }
                    else {
                        response.send(result);
                    }
                });
            });

            app.get(basePath + "/:promise/sessions", function (request, response) {
                response.contentType = "application/json; charset=utf-8";
                var top;
                var skip;
                var query;
                if (request.query.$top) {
                    top = parseInt(request.query.$top);
                }

                if (request.query.$skip) {
                    skip = parseInt(request.query.$skip);
                }

                if (request.query.$filter) {
                    try {
                        query = JSON.parse(request.query.$filter);
                    }
                    catch (reason) {
                        response.send({ error: "Invalid Query" }, 500);
                        return;
                    }
                }

                that.getSessions(request.params.promise,
                    query,
                    skip,
                    top,
                    function (err, result) {
                        if (err) {
                            response.send({ error: err }, 500);
                        }
                        else {
                            response.send(result);
                        }
                    });
            });
            
            var immediateCallback = function (err) {               
                if (err) {
                    console.log("Dispatch error: " + err);
                }
                setTimeout(that.dispatch, 5, immediateCallback);
            }

            MongoClient.connect(database, function (err, connection) {
                if (err) {
                    callback("error: could not connect to " + database + ", details: " + err);
                }
                else {
                    db = connection;
                    callback(null, that);

                    setTimeout(that.dispatch, 5,immediateCallback);
                    app.listen(port, function () {
                        console.log("Listening on " + port);
                    });
                }
            });
        }

        return that;
    }

    function run(definitions, database, port, basePath) {
        var promiseContainer = container(database);
        promiseContainer.run(port, basePath, function (err, result) {
            if (err) {
                console.log(err);
            }
            else {
                for (var definitionName in definitions) {
                    promiseContainer.patchPromise(definitionName, definitions[definitionName].getRoot(), function (err) { });
                }
            }
        });
    }

    return {
        promise: promise,
        idle: idle,
        suspend: suspend,
        checkpoint: checkpoint,
        post: post,
        waitAnyEvent: waitAnyEvent,
        waitAllEvents: waitAllEvents,
        tryCondition: tryCondition,
        tryEvents: tryEvents,
        delay: delay,
        startTimer: startTimer,
        tryTimer: tryTimer,
        receive: receive,
        tryReceive: tryReceive,
        mapReduce: mapReduce,
        map: map,
        tryReduce: tryReduce,
        waitAnyStream: waitAnyStream,
        waitAllStreams: waitAllStreams,
        startStreams: startStreams,
        tryJoinStreams: tryJoinStreams,
        stateChart: stateChart,
        flowChart: flowChart,
        run: run
    };
}();