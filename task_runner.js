var _ = require("lodash");
var colors = require("colors/safe");
var Promise = require("bluebird");

function makeRunner() {
	var setup = [],
		tasks = [],
		teardown = [],
		running = false,
		taskFailed = false,
		runFailed = false,
		failReason = null;

	function outputTaskLine(text, colorFunc) {
		var consoleWidth = process.stdout.columns || 80,
			prefixWidth = 3;
		text = " " + text + " ";
		var line = colors.bold("=".repeat(prefixWidth) + text + "=".repeat(consoleWidth - prefixWidth - text.length - 1));
		if (colorFunc) line = colorFunc(line);
		console.log(line);
	}

	function finishTask(task, result) {
		var successString = task.name + " Success",
			failureString = task.name + " Failure";
		if (_.isString(result)) {
			console.log(result);
		}
		if (taskFailed && failReason) {
			console.log(colors.red("Task failed: " + failReason));
			failReason = undefined;
		}
		console.log((taskFailed ? colors.red : colors.green)(">>> " + (taskFailed ? failureString : successString)));
	}

	function runTask(task) {
		taskFailed = false;
		var startString = "Running " + task.name;
		outputTaskLine(startString);
		try {
			var result = task();
		} catch (err) {
			fail(err.stack);
		}
		if (result && _.isFunction(result.then)) { // returned a promise, wait for completion
			return result.then(successResult => finishTask(task, successResult),
				failReason => {
					fail(failReason);
					finishTask(task);
				});
		} else {
			finishTask(task, result);
			return Promise.resolve();
		}
	}

	function runTaskList(tasksArr, listName, ignoreFailure = false) {
		return new Promise(resolveList => {
			if (tasksArr.length) {
				console.log(colors.grey("Running " + listName));
			}
			Promise.each(tasksArr, task => {
				return runFailed && !ignoreFailure ? Promise.resolve() : runTask(task);
			}).finally(resolveList);
		});
	}

	function fail(reason) {
		if (!running) throw new Error("Cannot fail task- not running.");
		taskFailed = runFailed = true;
		failReason = reason;
	}
	return {
		addTask(method, setupSteps = [], teardownSteps = []) {
			if (!_.isFunction(method)) throw new Error("Expected function");
			if (running) throw new Error("Cannot add task- already running.");
			tasks.push(method);
			setup = _.union(setup, setupSteps);
			teardown = _.union(teardown, teardownSteps);
			return this;
		},
		run() {
			running = true;
			runFailed = false;
			failReason = null;

			runTaskList(setup, "setup")
				.then(() => runTaskList(tasks, "tasks"))
				.then(() => runTaskList(teardown, "cleanup", true))
				.finally(() => running = false);

			return this;
		},
		fail
	};
}

module.exports = makeRunner;