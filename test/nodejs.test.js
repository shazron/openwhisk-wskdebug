/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-env mocha */

'use strict';

// tests for node.js debugging

// here is how most tests are setup:
// - requests to openwhisk and the agent are mocked using nock
// - docker is required and the containers actually run

const wskdebug = require('../index');
const Debugger = require("../src/debugger");

const test = require('./test');
const assert = require('assert');
const fse = require('fs-extra');
const fs = require('fs');
const sleep = require('util').promisify(setTimeout);
const tmp = require('tmp');
const chmodr = require('chmodr');

const BUILD_DIR = "build";

function makeTempDir() {
    tmp.setGracefulCleanup();
    fse.ensureDirSync(BUILD_DIR)
    const tmpobj = tmp.dirSync({
        dir: BUILD_DIR,
        unsafeCleanup: true
    });
    return tmpobj.name;
}

describe('nodejs', function() {
    this.timeout(30000);

    before(function() {
        test.isDockerInstalled();
    });

    beforeEach(async function() {
        await test.beforeEach();
    });

    afterEach(function() {
        test.afterEach();

        delete process.env.DEBUG;
        delete process.env.WSK_NODE_DEBUG;
    });

    it("should run an action without local sources", async function() {
        test.mockActionAndInvocation(
            "myaction",
            `function main(params) {
                return {
                    msg: 'CORRECT',
                    input: params.input
                }
            }`,
            { input: "test-input" },
            { msg: "CORRECT", input: "test-input" }
        );

        await wskdebug(`myaction -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with plain js and flat source structure", async function() {
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" }
        );

        process.chdir("test/nodejs/plain-flat");
        await wskdebug(`myaction action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with plain js and one level deep source structure", async function() {
        test.mockActionAndInvocation(
            "myaction",
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" }
        );

        process.chdir("test/nodejs/plain-onelevel");
        await wskdebug(`myaction lib/action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("it should always use linux paths in docker code", async function() {
        const nodejs = require("../src/kinds/nodejs/nodejs")
        const path = require("path")

        // manually mock path
        path.sep = '\\'
        const posix = path.posix
        path.posix = { sep: '/' }

        process.chdir("test/nodejs/plain-onelevel");
        const ret = nodejs.mountAction({
            sourceFile: 'lib\\action.js',
            sourcePath: 'lib/action.js'
        })

        // restore mock
        path.sep = '/'
        path.posix = posix

        // asserts
        assert(ret.code.includes('lib/action.js'))
        assert(!ret.code.includes('lib\\action.js'))
    });

    it("should mount local sources with a require(../) dependency", async function() {
        this.timeout(10000);
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" },
            true // binary
        );

        process.chdir("test/nodejs/commonjs-onelevel");
        await wskdebug(`myaction lib/action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with a require(../) dependency reported as non binary", async function() {
        this.timeout(10000);
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" }
        );

        process.chdir("test/nodejs/commonjs-onelevel");
        await wskdebug(`myaction lib/action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with a require(../) dependency using absolute paths", async function() {
        this.timeout(10000);
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" },
            true // binary
        );

        process.chdir("test/nodejs/commonjs-onelevel");
        await wskdebug(`myaction ${process.cwd()}/lib/action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with a require(../) dependency and run build with --on-build set", async function() {
        this.timeout(10000);
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" }
        );

        process.chdir("test/nodejs/commonjs-onelevel");
        fse.removeSync("build");

        // simulate a build that moves things into a separate directory with different naming
        const onBuild = "mkdir -p build/out; cp -R lib build/out/folder; cp dependency.js build/out";
        await wskdebug(`myaction lib/action.js --on-build '${onBuild}' --build-path build/out/folder/action.js -p ${test.port}`);

        fse.removeSync("build");
        test.assertAllNocksInvoked();
    });

    it("should mount and run local sources with a comment on the last line", async function() {
        test.mockActionAndInvocation(
            "myaction",
            `const main = () => ({ msg: 'WRONG' });`,
            { },
            { msg: "CORRECT" }
        );

        process.chdir("test/nodejs/trailing-comment");
        await wskdebug(`myaction -p ${test.port} action.js`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with commonjs and flat source structure", async function() {
        test.mockActionAndInvocation(
            "myaction",
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT/RESULT" },
            true // binary = true for nodejs means zip action with commonjs (require) loading
        );

        process.chdir("test/nodejs/commonjs-flat");
        await wskdebug(`myaction action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with plain js reported as binary", async function() {
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" },
            true // binary
        );

        process.chdir("test/nodejs/plain-flat");
        await wskdebug(`myaction action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should mount local sources with commonjs reported as non binary", async function() {
        this.timeout(10000);
        test.mockActionAndInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT/RESULT" },
            false // binary
        );

        process.chdir("test/nodejs/commonjs-flat");
        await wskdebug(`myaction action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should invoke and handle action when a source file changes and -P is set", async function() {
        const action = "myaction";
        const code = `const main = () => ({ msg: 'WRONG' });`;

        test.mockAction(action, code);
        test.expectAgent(action, code);

        // mock agent & action invocaton logic on the openwhisk side
        const ACTIVATION_ID = "1234567890";
        let invokedAction = false;
        let completedAction = false;

        test.nockActivation("myaction")
            .reply(async (uri, body) => {
                let response = [];
                // wskdebug polling the agent
                if (body.$waitForActivation === true) {
                    // when the action got invoked, we tell it wskdebug
                    // but only once
                    if (invokedAction && !completedAction) {
                        response = [ 200, {
                            response: {
                                result: {
                                    $activationId: ACTIVATION_ID
                                }
                            }
                        }];
                    } else {
                        // tell wskdebug to retry polling
                        response = [ 502, test.agentRetryResponse() ];
                    }
                } else if (body.key === "invocationOnSourceModification") {
                    // the action got invoked
                    invokedAction = true;
                    response = [ 200, { activationId: ACTIVATION_ID } ];

                } else if (body.$activationId === ACTIVATION_ID) {
                    // action was completed by wskdebug
                    completedAction = true;
                    response = [200, {}];
                }
                return response;
            })
            .persist();

        // wskdebug myaction action.js -l -P '{...}' -p ${test.port}
        process.chdir("test/nodejs/plain-flat");
        const argv = {
            port: test.port,
            action: "myaction",
            sourcePath: `${process.cwd()}/action.js`,
            invokeParams: '{ "key": "invocationOnSourceModification" }'
        };

        const dbgr = new Debugger(argv);
        await dbgr.start();
        dbgr.run();

        // wait a bit
        await test.sleep(500);

        // simulate a source file change
        test.touchFile("action.js");

        // eslint-disable-next-line no-unmodified-loop-condition
        while (!completedAction && test.hasNotTimedOut(this)) {
            await test.sleep(100);
        }

        await dbgr.stop();

        assert.ok(invokedAction, "action was not invoked on source change");
        assert.ok(completedAction, "action invocation was not handled and completed");
        test.assertAllNocksInvoked();
    });

    it("should invoke and handle action when a source file changes and --on-build and --build-path and -P are set", async function() {
        this.timeout(10000);
        const action = "myaction";
        const code = `const main = () => ({ msg: 'WRONG' });`;

        test.mockAction(action, code);
        test.expectAgent(action, code);

        // mock agent & action invocaton logic on the openwhisk side
        const ACTIVATION_ID = "1234567890";
        let invokedAction = false;
        let completedAction = false;

        test.nockActivation("myaction")
            .reply(async (uri, body) => {
                let response = [];
                // wskdebug polling the agent
                if (body.$waitForActivation === true) {
                    // when the action got invoked, we tell it wskdebug
                    // but only once
                    if (invokedAction && !completedAction) {
                        response = [ 200, {
                            response: {
                                result: {
                                    $activationId: ACTIVATION_ID
                                }
                            }
                        }];
                    } else {
                        // tell wskdebug to retry polling
                        response = [ 502, test.agentRetryResponse() ];
                    }
                } else if (body.key === "invocationOnSourceModification") {
                    // the action got invoked
                    invokedAction = true;
                    response = [ 200, { activationId: ACTIVATION_ID } ];

                } else if (body.$activationId === ACTIVATION_ID) {
                    // action was completed by wskdebug
                    if (body.msg === "CORRECT") {
                        completedAction = true;
                        response = [200, {}];
                    } else {
                        response = [502, test.agentExitResponse()];
                    }
                }
                return response;
            })
            .persist();

        // wskdebug myaction action.js --on-build "..." --build-path build/action.js -P '{...}' -p ${test.port}
        process.chdir("test/nodejs/build-step");

        fse.removeSync("build");

        const argv = {
            port: test.port,
            action: "myaction",
            // copy a different file with "CORRECT in it"
            onBuild: `mkdir -p build; cp action-build.txt build/action.js`,
            buildPath: `build/action.js`,
            sourcePath: `action.js`,
            invokeParams: '{ "key": "invocationOnSourceModification" }'
        };

        const dbgr = new Debugger(argv);
        await dbgr.start();
        dbgr.run();

        // wait a bit
        await test.sleep(500);

        // simulate a source file change
        test.touchFile("action.js");

        // eslint-disable-next-line no-unmodified-loop-condition
        while (!completedAction && test.hasNotTimedOut(this)) {
            await test.sleep(100);
        }

        await dbgr.stop();

        fse.removeSync("build");
        assert.ok(invokedAction, "action was not invoked on source change");
        assert.ok(completedAction, "action invocation was not handled and completed");
        test.assertAllNocksInvoked();
    });

    it("should reload local plain sources on file modification", async function() {
        this.timeout(10000);

        // create copy in temp dir so we can modify it
        const tmpDir = makeTempDir();
        fse.copySync("test/nodejs/plain-flat", tmpDir);
        chmodr.sync(tmpDir, 0o755);
        process.chdir(tmpDir);

        test.mockActionDoubleInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT" },
            async () => {
                // change action.js to test reloading
                console.log("simulating modifiying action.js...");

                fs.writeFileSync(`action.js`,
                    `
                    'use strict';

                    function main(params) {
                        return { msg: "SECOND" };
                    }
                `);

                await sleep(1);
            },
            { msg: "SECOND" },
            true // binary
        );

        await wskdebug(`myaction action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should reload local commonjs sources on file modification", async function() {
        this.timeout(10000);

        // create copy in temp dir so we can modify it
        const tmpDir = makeTempDir();
        fse.copySync("test/nodejs/commonjs-flat", tmpDir);
        chmodr.sync(tmpDir, 0o755);
        process.chdir(tmpDir);

        test.mockActionDoubleInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "CORRECT/RESULT" },
            async () => {
                // change action.js to test reloading
                console.log("[test] simulating modifiying action.js...");

                fs.writeFileSync(`action.js`,
                    `
                    'use strict';

                    exports.main = function() {
                        return { msg: "SECOND" };
                    }
                `);

                await sleep(100);
            },
            { msg: "SECOND" },
            true // binary
        );

        await wskdebug(`myaction action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should reload local commonjs sources with a require() dependency on file modification", async function() {
        this.timeout(10000);

        // create copy in temp dir so we can modify it
        const tmpDir = makeTempDir();
        fse.copySync("test/nodejs/commonjs-deps", tmpDir);
        chmodr.sync(tmpDir, 0o755);
        process.chdir(tmpDir);

        test.mockActionDoubleInvocation(
            "myaction",
            // should not use this code if we specify local sources which return CORRECT
            `const main = () => ({ msg: 'WRONG' });`,
            {},
            { msg: "FIRST" },
            async () => {
                // change dependency.js to test reloading of require() deps
                console.log("simulating modifiying depdency.js...");

                fs.writeFileSync(`dependency.js`,
                    `
                    'use strict';

                    module.exports = {
                        msg: "SECOND"
                    }
                `);

                await sleep(1);
            },
            { msg: "SECOND" },
            true // binary
        );

        await wskdebug(`myaction action.js -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should pass through DEBUG and NODE_DEBUG env vars", async function() {
        test.mockActionAndInvocation(
            "myaction",
            `function main(params) {
                return {
                    msg: 'CORRECT',
                    debug: process.env.DEBUG,
                    nodeDebug: process.env.NODE_DEBUG,
                }
            }`,
            { },
            {
                msg: "CORRECT",
                debug: "debug",
                nodeDebug: "node_debug"
            }
        );

        process.env.DEBUG = "debug";
        process.env.WSK_NODE_DEBUG = "node_debug";
        await wskdebug(`myaction -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    it("should run an action with custom DOCKER_HOST_IP env var set", async function() {
        test.mockActionAndInvocation(
            "myaction",
            `function main(params) {
                return {
                    msg: 'CORRECT',
                    input: params.input
                }
            }`,
            { input: "test-input" },
            { msg: "CORRECT", input: "test-input" }
        );

        // 0.0.0.0 (default) or 127.0.0.1 should work if we are on the docker host
        process.env.DOCKER_HOST_IP = "127.0.0.1";

        await wskdebug(`myaction -p ${test.port}`);

        test.assertAllNocksInvoked();
    });

    // TODO: test -l livereload connection

    // TODO: test agents - conditions (unit test agent code locally)

    // TODO: test breakpoint debugging
    // TODO: test action options
    // TODO: test debugger options

});
