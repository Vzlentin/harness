# Changelog

## [0.7.0](https://github.com/Vzlentin/harness/compare/v0.6.2...v0.7.0) (2026-11-14)


### ⚠ BREAKING CHANGES

* @vzlentin/harness/herdr exports hc in place of herdr, and does not export agentReporter or piEnv. openConversationPane takes { space }, { side: true } or {} in place of { pane } or { workspace }. workflows uses both, so it must change too.
* ./answer is now ./respond, runHost drops stateDir, entries own their catchUp hook, and @earendil-works/* is 1.5.0.

### Features

* add the harness todo command, with the runner of the todo tool ([aebe4c0](https://github.com/Vzlentin/harness/commit/aebe4c0d7dba8bb54fa364dd2252aa99cdb3aea8))
* add the tree of a project, its watch, and harness todo sort ([40619c8](https://github.com/Vzlentin/harness/commit/40619c801572676e13de811aa85620658bd0630f))
* dim the page during a Send, and send the same answer only one time ([cdf7ada](https://github.com/Vzlentin/harness/commit/cdf7adae57ff18cd0846611a093396cd88f1ca73))
* enforce the limits of the RLM children in the host ([d784a6d](https://github.com/Vzlentin/harness/commit/d784a6d546050a5fb353ddf1e563f60b32209970))
* export the document of started task keys ([#44](https://github.com/Vzlentin/harness/issues/44)) ([c73f8e3](https://github.com/Vzlentin/harness/commit/c73f8e359cb5de5b9c2f9f5358565c52f9587d56))
* give a hosted bash call with no timeout a default limit of 300 seconds ([4d5d81d](https://github.com/Vzlentin/harness/commit/4d5d81db2ba975c29c0908c75efb6015d6bacef7))
* give subagent spawns a default model and thinking level from Pi's settings ([#48](https://github.com/Vzlentin/harness/issues/48)) ([7c78dcc](https://github.com/Vzlentin/harness/commit/7c78dccf93e303aaf107901a84bd5afcad5c4e70))
* give the agents tools for the threads, rules, terms and parts of the project ([0f5799e](https://github.com/Vzlentin/harness/commit/0f5799ecd61384de261f8b070177a01966b42db7))
* give the project agent and each child the todo tool ([d5ae529](https://github.com/Vzlentin/harness/commit/d5ae529fba82ee34c740974e15c95020ee744fc1))
* give the todo list of a conversation in its watch ([f85003f](https://github.com/Vzlentin/harness/commit/f85003fa9c3bbcd9c1c2f5cdf3d279d3cef9a0c3))
* hold the tool calls that break a conduct rule of the project ([5972c03](https://github.com/Vzlentin/harness/commit/5972c0397bfa66729047d49bb20debf0bc38d45d))
* keep lists of todos in the host, with the todo request and subpath ([ae197b8](https://github.com/Vzlentin/harness/commit/ae197b890f5fd587cb187f1311ee9879b432b130))
* keep the Mac awake on AC power while the host has active work ([ab78f48](https://github.com/Vzlentin/harness/commit/ab78f48205f2703c2c8f9e46a2ae7a7ab6b400ae))
* keep the persons, threads, messages, rules, terms and parts of a project in the host store ([a80ca00](https://github.com/Vzlentin/harness/commit/a80ca00a780904db85acc1edd50dedb01e7d215f))
* mark the RLM children rlm in list, the widget and the mirror sessions ([2305663](https://github.com/Vzlentin/harness/commit/2305663f8a1667cbf5ea4f2276d3fcf3558fb694))
* move the rlm text from each system prompt to rlm.__doc__ ([489fc8e](https://github.com/Vzlentin/harness/commit/489fc8ec871d52cdee82da366b5eb530d6766c07))
* move visual copy into pi-agents and mark a copied draft as sent ([ae56b67](https://github.com/Vzlentin/harness/commit/ae56b6740ef419cd5cb1cd1c88ba1280ab0b8767))
* name run sessions by their label in the catch-up ([#39](https://github.com/Vzlentin/harness/issues/39)) ([9094fcb](https://github.com/Vzlentin/harness/commit/9094fcb8c9c9e4aabdf252d44b687dc7da0c050c))
* open agents through hc and herdr-app, and report done to the terminal ([3ac93cf](https://github.com/Vzlentin/harness/commit/3ac93cfdd00bcb0b65f8a9ec8cc55d78ac76251c))
* separate the depth budget from the tree parent, with leaves at the limit ([f5cefb9](https://github.com/Vzlentin/harness/commit/f5cefb958ae4442dd21f9a4c15fc8d5dafec26eb))
* serve pages with harness page, and post their Send to an agent ([5b21279](https://github.com/Vzlentin/harness/commit/5b2127979f1865612381a4dcfb3e1a4331e9ff65))
* serve rlm to the IPython kernels of interactive Pi ([b9e8397](https://github.com/Vzlentin/harness/commit/b9e8397ceec802e73a163d6b0e54601ea04eb6fb))
* serve rlm to the IPython kernels of the host ([f98be18](https://github.com/Vzlentin/harness/commit/f98be18b059203fa03eb0d9339eff42ddd858e96))
* show and steer an agent in a browser with harness inspect ([0068ed1](https://github.com/Vzlentin/harness/commit/0068ed19b2ee08563cd548a296ea92cd32e0262c))
* show the todo list in Pi, and give Pi sessions the todo tool ([c321444](https://github.com/Vzlentin/harness/commit/c321444b5a8a88481359b46c527a0a8a0b33931f))
* show the todo widget above the editor with a header and the open todos ([739b1e6](https://github.com/Vzlentin/harness/commit/739b1e692ced08902b15b8807191ff37d5466ddb))
* track the state of each message out and give each agent a digest of what waits ([0f1b834](https://github.com/Vzlentin/harness/commit/0f1b834cda7fa13959a72df69d1ce78d397bec0f))
* watch the objects of a project from a socket client ([040047e](https://github.com/Vzlentin/harness/commit/040047edf3f702c5d96996c6a56a5ff047a9a7d9))


### Bug Fixes

* break stale lock files one at a time, and make the tests pass under load ([3ad7fc6](https://github.com/Vzlentin/harness/commit/3ad7fc6d71f8ab706ba3b6aea39b7328ce71812c))
* hide the subagents widget when no host runs ([fd94c25](https://github.com/Vzlentin/harness/commit/fd94c25392b885230e8f53245bf096ef8bced70e))
* initialize the extension context for virtual models in the host ([a8a68c7](https://github.com/Vzlentin/harness/commit/a8a68c7f7b28c7406c9e86c59b3e1759a205b9bc))
* install the signal handlers of harness inspect before it prints the URLs ([b880dcb](https://github.com/Vzlentin/harness/commit/b880dcb8841c9bb99ddf3143b539ea9ca8a14cf5))
* make the harness state machines explicit and crash-safe ([#43](https://github.com/Vzlentin/harness/issues/43)) ([b4c8ed7](https://github.com/Vzlentin/harness/commit/b4c8ed750207a8b22bc0a5b51f1366f76256b280))
* set the retry timer of a failed push from the clock reading of the sweep ([#49](https://github.com/Vzlentin/harness/issues/49)) ([f28eb84](https://github.com/Vzlentin/harness/commit/f28eb848e7cbbf57ca15ba0ac6fac9de918c28f4))


### Code Refactoring

* fix the harness slop, cut src/ into concept groups, and move to Pi 1.5.0 ([#45](https://github.com/Vzlentin/harness/issues/45)) ([d3fd7b5](https://github.com/Vzlentin/harness/commit/d3fd7b5cfa5403779ac917b2ee9219350f7c655e))

## [0.6.2](https://github.com/Vzlentin/harness/compare/v0.6.1...v0.6.2) (2026-10-31)


### Features

* add project memory, passive notes, catch-up and overlays to the host ([#37](https://github.com/Vzlentin/harness/issues/37)) ([8510a86](https://github.com/Vzlentin/harness/commit/8510a866875122c6ea9267b6e194b563e14db862))

## [0.6.1](https://github.com/Vzlentin/harness/compare/v0.6.0...v0.6.1) (2026-10-29)


### Features

* **pi:** ship the subagent skill in pi-agents ([#35](https://github.com/Vzlentin/harness/issues/35)) ([433b3c4](https://github.com/Vzlentin/harness/commit/433b3c464e4dac294cd7fa453d95a9f0221661ca))

## [0.6.0](https://github.com/Vzlentin/harness/compare/v0.5.1...v0.6.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* @vzlentin/harness/setup is gone. workflows must drop its import of it.

### Features

* install harness through Pi, with pi-agents depending on harness ([#33](https://github.com/Vzlentin/harness/issues/33)) ([ff9fc23](https://github.com/Vzlentin/harness/commit/ff9fc23451b1eaee1acf3ad865c67bc201251a96))

## [0.5.1](https://github.com/Vzlentin/harness/compare/v0.5.0...v0.5.1) (2026-10-27)


### Bug Fixes

* **pi:** count an install older than the extension as not installed ([#31](https://github.com/Vzlentin/harness/issues/31)) ([a806130](https://github.com/Vzlentin/harness/commit/a80613044b96396f0425062452295aee9f21f557))

## [0.5.0](https://github.com/Vzlentin/harness/compare/v0.4.1...v0.5.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* the protocol goes from 9 to 10, for the answers request. A client refuses a host with the other version.

### Features

* push the answer of a subagent to its parent ([#29](https://github.com/Vzlentin/harness/issues/29)) ([f044ab7](https://github.com/Vzlentin/harness/commit/f044ab750220cf04ada4eb2bbf1a148ca5d353be))

## [0.4.1](https://github.com/Vzlentin/harness/compare/v0.4.0...v0.4.1) (2026-10-25)


### Bug Fixes

* **deps:** move to pi 1.4.0 ([#27](https://github.com/Vzlentin/harness/issues/27)) ([7de0cad](https://github.com/Vzlentin/harness/commit/7de0cad2300ff6d867e058dc6a48949a18139f4f))

## [0.4.0](https://github.com/Vzlentin/harness/compare/v0.3.1...v0.4.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* setup(packageDir) and setupOnce(packageDir) of @vzlentin/harness/setup now take a second argument, the npm name of the Pi package. workflows needs a new peer range.

### Features

* add harness --version ([eb94696](https://github.com/Vzlentin/harness/commit/eb94696d6a13513e13e820de78ad47985a3a00e9))
* offer to install harness at session start ([33f4bf1](https://github.com/Vzlentin/harness/commit/33f4bf15f8ff48b3ed19f49881cedc1af4f88696))
* pin npm:&lt;piPackage&gt;@&lt;version&gt; in Pi at setup ([74d905d](https://github.com/Vzlentin/harness/commit/74d905ddedac9047c7bb5fb4b6b11f921758f8f1))
* publish pi/ as @vzlentin/pi-agents and load the global harness ([fe3222b](https://github.com/Vzlentin/harness/commit/fe3222b07f48bdac79f833bc5fa647e988ef80bd))
* wait on the harness install lock before the extension looks up harness ([90f3113](https://github.com/Vzlentin/harness/commit/90f3113029a888afdf66f190774935815a883b07))

## [0.3.1](https://github.com/Vzlentin/harness/compare/v0.3.0...v0.3.1) (2026-10-24)


### Features

* export a Herdr function that opens a library conversation in a pane ([a5272f3](https://github.com/Vzlentin/harness/commit/a5272f3f415429014bbf0ea94fb6996e995fee17))
* let watch, input and abort target a children library conversation ([b5263b8](https://github.com/Vzlentin/harness/commit/b5263b8af2c4b21ee3519d3c2cb429c0ae54c2e4))
* open a library conversation with harness attach --conversation ([8a43741](https://github.com/Vzlentin/harness/commit/8a437410e23980a09bba3f160aae65e134605d48))
* report the mirrored agent with OSC 7501 ([05d78a0](https://github.com/Vzlentin/harness/commit/05d78a02a486d0fec95821c492a4be95d69f8e1c))
