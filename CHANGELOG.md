# Changelog

## [0.7.0](https://github.com/Vzlentin/harness/compare/v0.6.2...v0.7.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* children get only read, write, edit and bash, and a store written by this host does not open in a host on @earendil-works 1.5.
* store.json has the version 2, with `items` and `lastItem`, and `StoreFile` of `@vzlentin/harness/protocol` parses only that version. `subagent.children` has the version 6, so an older host cannot open a store that a new host started.
* the `todo` tool has no `list` parameter, and `todoToolTarget` is gone from `@vzlentin/harness/tool`. `harness todo --project-list` fails with `Unknown todo argument: --project-list`. `classify-todos` without `list`, and `harness todo sort` without a target, use the open work items in place of the project list.
* `ServesInput` takes `{ item }` in place of `{ todo }`, and `Served` gives `{ kind: "item", id }` in place of `{ kind: "todo", id }`. `harness spawn --todo` is gone. workflows and Orda still send `{ todo }`. They need their own change.
* give the thread of the source of a rule
* give the degraded states of the host in watch-project
* record the author of each answer of an ask
* let the gate read only the inputs that the user typed
* let only the user decide, retire, edit, create and delete a rule
* remove the term and part tools from the project store
* let the host serve an external client of another protocol version
* end an agent when what it serves ends, once its todos are done
* end the subagents of a Pi session when the session ends
* let a terminal that is not an agent stop any child, by handle or conversation ID
* keep a stopped child, and let a message resume it
* let an input resume a child that the children library ended
* the IPython kernel has no rlm, and @vzlentin/harness has no ./rlm export and no python/harness_rlm.py. The kernel has tools in its place, from python/harness_tools.py, and the Pi extension uses the ./bridge export. A spawn from a cell without notify now pushes the answer of the child to its conversation.
* @vzlentin/harness/protocol no longer exports ChildKind. ChildInfo, the spawn request and the subagent tool output have no kind field. The protocol version is now 24.
* runHost of @vzlentin/harness/host no longer takes rlmDeadlineMs. The Children type of @vzlentin/harness/children no longer has closed.
* @vzlentin/harness/herdr exports hc in place of herdr, and does not export agentReporter or piEnv. openConversationPane takes { space }, { side: true } or {} in place of { pane } or { workspace }. workflows uses both, so it must change too.
* ./answer is now ./respond, runHost drops stateDir, entries own their catchUp hook, and @earendil-works/* is 1.5.0.

### Features

* add /todo for session todos ([10688c8](https://github.com/Vzlentin/harness/commit/10688c8aa3ef6670bc5bc1209cc76fe7c86d9fcd))
* add harness attach --side, to open an agent in a pane beside the caller ([37c04b0](https://github.com/Vzlentin/harness/commit/37c04b09fec272525b570b49e3295e4e373775ab))
* add harness parley show to print a parley as Markdown ([ae980bc](https://github.com/Vzlentin/harness/commit/ae980bc9aaab8aabcd05afeaf3e4f6d705737ad1))
* add harness store load to load a store.json into an empty store ([3fcd855](https://github.com/Vzlentin/harness/commit/3fcd8553c04a08eaa999e306f53a3fbc8405a721))
* add the harness todo command, with the runner of the todo tool ([aebe4c0](https://github.com/Vzlentin/harness/commit/aebe4c0d7dba8bb54fa364dd2252aa99cdb3aea8))
* add the item tool and harness item, and end the project todo list ([32acb9d](https://github.com/Vzlentin/harness/commit/32acb9ddf74ebf25e7754b289321f2efca613a19))
* add the memory tool, its compressor and the memory section to the host ([e7d66c1](https://github.com/Vzlentin/harness/commit/e7d66c160024065019bf8703ccae6640569c047b))
* add the needs edge from an item to the item that it waits for ([5c1eb65](https://github.com/Vzlentin/harness/commit/5c1eb6560ff3abb1e263e5b066c72fe3d512ad56))
* add the parley tool for each hosted conversation and for Pi ([8942a62](https://github.com/Vzlentin/harness/commit/8942a622f25dd0951996746e0f4f17724e4f45b4))
* add the query action, to ask a model about a conversation of the host ([aa5531d](https://github.com/Vzlentin/harness/commit/aa5531de7f0c760af3e951145cf3b0872784d9e7))
* add the todo Save to the vault only when VAULT of the host names a folder that exists ([3114be2](https://github.com/Vzlentin/harness/commit/3114be2045ed6bab7fd3e1cf7488ea19506d1340))
* add the todo Save to the vault when the user answers an ask, and close it at the note ([39066c6](https://github.com/Vzlentin/harness/commit/39066c68013b2472a3135d27cb6fd0084edcbde7))
* add the tree of a project, its watch, and harness todo sort ([40619c8](https://github.com/Vzlentin/harness/commit/40619c801572676e13de811aa85620658bd0630f))
* add work items to the store of the host, with the item request, in protocol 36 ([95f8e1f](https://github.com/Vzlentin/harness/commit/95f8e1fed78a87df7d1ad33d7e10442d2ef1f114))
* cut the answer of every child at 256 KiB in wait and in a push ([25f9f76](https://github.com/Vzlentin/harness/commit/25f9f76e4a1dfce5d22f6ef5700f57e046dec8bf))
* deliver the answers of the user to the asker of the asks ([93dd498](https://github.com/Vzlentin/harness/commit/93dd4981b4d124a024ac46ae49ff5b7652d26ce5))
* dim the page during a Send, and send the same answer only one time ([cdf7ada](https://github.com/Vzlentin/harness/commit/cdf7adae57ff18cd0846611a093396cd88f1ca73))
* end a contract when its last open item closes, and refuse parley end while it shapes an open item ([9be9652](https://github.com/Vzlentin/harness/commit/9be965241ec4bd0df462978a4a0dd14dbc4f9edc))
* end an agent when what it serves ends, once its todos are done ([582ea8b](https://github.com/Vzlentin/harness/commit/582ea8b2d0f152913f5711c7822309ad887a250e))
* end the subagents of a Pi session when the session ends ([81d7cf5](https://github.com/Vzlentin/harness/commit/81d7cf50930e96a08eaaaf268892799c4782fd21))
* enforce the limits of the RLM children in the host ([d784a6d](https://github.com/Vzlentin/harness/commit/d784a6d546050a5fb353ddf1e563f60b32209970))
* export the document of started task keys ([#44](https://github.com/Vzlentin/harness/issues/44)) ([c73f8e3](https://github.com/Vzlentin/harness/commit/c73f8e359cb5de5b9c2f9f5358565c52f9587d56))
* give a hosted bash call with no timeout a default limit of 300 seconds ([4d5d81d](https://github.com/Vzlentin/harness/commit/4d5d81db2ba975c29c0908c75efb6015d6bacef7))
* give children only the pi-durable tools, and move to [@earendil-works](https://github.com/earendil-works) 1.6.0 ([ea27201](https://github.com/Vzlentin/harness/commit/ea272014e184889d0108ee949efbe80e549814a3))
* give each child Pi's tool-use rules in a rules section ([d768bb1](https://github.com/Vzlentin/harness/commit/d768bb1e1949dd924b094424c540c9251e427ff5))
* give each work item its stage and needsYou, and refuse done while a run that serves it is live ([a4e457f](https://github.com/Vzlentin/harness/commit/a4e457f57783f804f67b22256cb01b37558ac870))
* give subagent spawns a default model and thinking level from Pi's settings ([#48](https://github.com/Vzlentin/harness/issues/48)) ([7c78dcc](https://github.com/Vzlentin/harness/commit/7c78dccf93e303aaf107901a84bd5afcad5c4e70))
* give the agents tools for the threads, rules, terms and parts of the project ([0f5799e](https://github.com/Vzlentin/harness/commit/0f5799ecd61384de261f8b070177a01966b42db7))
* give the degraded states of the host in watch-project ([64f38c9](https://github.com/Vzlentin/harness/commit/64f38c9cbb546897ed74b983cd0fad41249cc7ff))
* give the digest to a plain Pi session and again after a compaction ([65d92a8](https://github.com/Vzlentin/harness/commit/65d92a88f1dce7c233cd366f84a2e6ee1fb3e901))
* give the memory tool and the memory section to a Pi session ([5662110](https://github.com/Vzlentin/harness/commit/56621106df909d5c864e1d12ec0a69e4d0b232b7))
* give the open work items with their stage and needsYou in watch-project, and send an event when they change ([0c15886](https://github.com/Vzlentin/harness/commit/0c15886bdce29ed2290966947ebeb4c5d8b9b8cc))
* give the project agent and each child the todo tool ([d5ae529](https://github.com/Vzlentin/harness/commit/d5ae529fba82ee34c740974e15c95020ee744fc1))
* give the thread of the source of a rule ([7460a73](https://github.com/Vzlentin/harness/commit/7460a734ee583cb47e48bc754e9f57fb360f8b11))
* give the todo list of a conversation in its watch ([f85003f](https://github.com/Vzlentin/harness/commit/f85003fa9c3bbcd9c1c2f5cdf3d279d3cef9a0c3))
* hold the tool calls that break a conduct rule of the project ([5972c03](https://github.com/Vzlentin/harness/commit/5972c0397bfa66729047d49bb20debf0bc38d45d))
* keep a stopped child, and let a message resume it ([d46064e](https://github.com/Vzlentin/harness/commit/d46064ee720e562702aed86b4f26d792646493e3))
* keep lists of todos in the host, with the todo request and subpath ([ae197b8](https://github.com/Vzlentin/harness/commit/ae197b890f5fd587cb187f1311ee9879b432b130))
* keep the asks and the parleys in the project store, with their requests and the watch ([a645517](https://github.com/Vzlentin/harness/commit/a64551754d7effb1f0f1977408b4511a5b2d5033))
* keep the Mac awake on AC power while the host has active work ([ab78f48](https://github.com/Vzlentin/harness/commit/ab78f48205f2703c2c8f9e46a2ae7a7ab6b400ae))
* keep the persons, threads, messages, rules, terms and parts of a project in the host store ([a80ca00](https://github.com/Vzlentin/harness/commit/a80ca00a780904db85acc1edd50dedb01e7d215f))
* let a client of children.open leave out the tools of the project store ([3e50ec4](https://github.com/Vzlentin/harness/commit/3e50ec4a0431581850ac368f329fab0b98658710))
* let a page of harness page read the asks of its parley and write the answers of the user at Send ([7a3bb26](https://github.com/Vzlentin/harness/commit/7a3bb26d0e3ba07f6e4c78bd26debb2a577eeaa1))
* let a spawn serve a work item through a serves edge, and end its agents when the item is done or dropped ([86c158d](https://github.com/Vzlentin/harness/commit/86c158d9abe445bab168268c434757027ffc330b))
* let a terminal that is not an agent stop any child, by handle or conversation ID ([128354c](https://github.com/Vzlentin/harness/commit/128354cd5bfef0d821d3925146dc32bc3b1beba8))
* let an input resume a child that the children library ended ([6a7917a](https://github.com/Vzlentin/harness/commit/6a7917ad55c1a8017a4d37bf960b81e5dfc40642))
* let only the user decide, retire, edit, create and delete a rule ([d3c01c5](https://github.com/Vzlentin/harness/commit/d3c01c51fd685debbef39c41587bcc477240bba5))
* let the asker record the note of its ask, with the parley tool and harness parley note ([81644e8](https://github.com/Vzlentin/harness/commit/81644e8d11ec1ee1d36ca6ce458321d92ac33601))
* let the codemode scripts of hosted conversations call the MCP tools of Pi's config ([2e372ea](https://github.com/Vzlentin/harness/commit/2e372ea67941b0edeafab6a6d9f75bf6a93aaac5))
* let the gate read only the inputs that the user typed ([a40df09](https://github.com/Vzlentin/harness/commit/a40df099a3e8b6c45386ccf123760d3ccb65804a))
* let the host serve an external client of another protocol version ([f018c04](https://github.com/Vzlentin/harness/commit/f018c04a7d817b5579af5c1ef39cfcc2f33f535e))
* let the user edit and delete a message, log a message out as sent, and add a person to a thread ([89f2691](https://github.com/Vzlentin/harness/commit/89f2691c39cc296fc388f4ca43aee73616714e64))
* list the options of each open ask in the parley text, and add harness parley show --json ([a1b651a](https://github.com/Vzlentin/harness/commit/a1b651a60814de2300cf2d18e12a3d6c75c3bd7b))
* mark the RLM children rlm in list, the widget and the mirror sessions ([2305663](https://github.com/Vzlentin/harness/commit/2305663f8a1667cbf5ea4f2276d3fcf3558fb694))
* move the open project todos to items at the first start of the host, and write store.json version 2 with the items ([a7c9d86](https://github.com/Vzlentin/harness/commit/a7c9d86f4df1ddc928e7ecedacde0fd918e3b153))
* move the rlm text from each system prompt to rlm.__doc__ ([489fc8e](https://github.com/Vzlentin/harness/commit/489fc8ec871d52cdee82da366b5eb530d6766c07))
* move visual copy into pi-agents and mark a copied draft as sent ([ae56b67](https://github.com/Vzlentin/harness/commit/ae56b6740ef419cd5cb1cd1c88ba1280ab0b8767))
* name run sessions by their label in the catch-up ([#39](https://github.com/Vzlentin/harness/issues/39)) ([9094fcb](https://github.com/Vzlentin/harness/commit/9094fcb8c9c9e4aabdf252d44b687dc7da0c050c))
* open agents through hc and herdr-app, and report done to the terminal ([3ac93cf](https://github.com/Vzlentin/harness/commit/3ac93cfdd00bcb0b65f8a9ec8cc55d78ac76251c))
* put the decided rules of the project in the system prompt of each agent ([01dd90b](https://github.com/Vzlentin/harness/commit/01dd90b1c7ff0dec40a2fd6aca87ef5761f4e397))
* record the author of each answer of an ask ([99bb8d4](https://github.com/Vzlentin/harness/commit/99bb8d480487e70e3f915ec78e96c4090e989f43))
* record the ID of the vault note of an ask ([7a022c7](https://github.com/Vzlentin/harness/commit/7a022c729049df411d131c050749a673c5d8a2f2))
* remove the kind of a child ([f822717](https://github.com/Vzlentin/harness/commit/f8227171fd92e5ddedb83949af517cee2228230b))
* remove the live cap, the input cap, the pool and the deadline of RLM children ([0e9c542](https://github.com/Vzlentin/harness/commit/0e9c54228b7b2e869792b4af19c3859ae5a5c984))
* remove the term and part tools from the project store ([3e6dcdc](https://github.com/Vzlentin/harness/commit/3e6dcdc465cd4368216df73b32ba96702447a77d))
* replace rlm in the IPython kernel with a tools bridge ([2022504](https://github.com/Vzlentin/harness/commit/2022504c9b9fc13efb7bf7fb72656be531ec4f31))
* separate the depth budget from the tree parent, with leaves at the limit ([f5cefb9](https://github.com/Vzlentin/harness/commit/f5cefb958ae4442dd21f9a4c15fc8d5dafec26eb))
* serve pages with harness page, and post their Send to an agent ([5b21279](https://github.com/Vzlentin/harness/commit/5b2127979f1865612381a4dcfb3e1a4331e9ff65))
* serve rlm to the IPython kernels of interactive Pi ([b9e8397](https://github.com/Vzlentin/harness/commit/b9e8397ceec802e73a163d6b0e54601ea04eb6fb))
* serve rlm to the IPython kernels of the host ([f98be18](https://github.com/Vzlentin/harness/commit/f98be18b059203fa03eb0d9339eff42ddd858e96))
* ship the conduct of a parley as the parley skill of pi-agents ([9c9f07f](https://github.com/Vzlentin/harness/commit/9c9f07fa645a2d44072f065a48a0a509276339b3))
* show and steer an agent in a browser with harness inspect ([0068ed1](https://github.com/Vzlentin/harness/commit/0068ed19b2ee08563cd548a296ea92cd32e0262c))
* show the board of the project in the digest, and tell the chat agent to keep it true ([a2f29cb](https://github.com/Vzlentin/harness/commit/a2f29cb62914bc8588a1458426bedd064e31d7d6))
* show the todo list in Pi, and give Pi sessions the todo tool ([c321444](https://github.com/Vzlentin/harness/commit/c321444b5a8a88481359b46c527a0a8a0b33931f))
* show the todo widget above the editor with a header and the open todos ([739b1e6](https://github.com/Vzlentin/harness/commit/739b1e692ced08902b15b8807191ff37d5466ddb))
* show the whole todo list after each todo call, and the Save to the vault todos of an answer ([f5cc47c](https://github.com/Vzlentin/harness/commit/f5cc47c67e217c8c30c30e02e5718e804edfa24c))
* track the state of each message out and give each agent a digest of what waits ([0f1b834](https://github.com/Vzlentin/harness/commit/0f1b834cda7fa13959a72df69d1ce78d397bec0f))
* watch the objects of a project from a socket client ([040047e](https://github.com/Vzlentin/harness/commit/040047edf3f702c5d96996c6a56a5ff047a9a7d9))
* write the lists of the store to store.json after each change ([b3dabaf](https://github.com/Vzlentin/harness/commit/b3dabaf4b79c1ae330e329511dd115e491cac6f9))
* write the shapes edge of a parley from a round that names an item, and give a new contract an item ([1285072](https://github.com/Vzlentin/harness/commit/128507245998964c3af1ced96dbaff1c263be02d))


### Bug Fixes

* break stale lock files one at a time, and make the tests pass under load ([3ad7fc6](https://github.com/Vzlentin/harness/commit/3ad7fc6d71f8ab706ba3b6aea39b7328ce71812c))
* check the needs edges when a store file loads, and say in the parley tool when a contract ends ([8f9df5f](https://github.com/Vzlentin/harness/commit/8f9df5f69f648a059375a203f5f91b6dabf6b4f2))
* checkpoint the documents of the host store after 64 deltas ([cb03f88](https://github.com/Vzlentin/harness/commit/cb03f88b630e2b127af5f9a19ded578db839ed96))
* find the project of a directory by its real path ([dba8e63](https://github.com/Vzlentin/harness/commit/dba8e63a67ee19a46d293e283b7db280836382c2))
* hide the subagents widget when no host runs ([fd94c25](https://github.com/Vzlentin/harness/commit/fd94c25392b885230e8f53245bf096ef8bced70e))
* initialize the extension context for virtual models in the host ([a8a68c7](https://github.com/Vzlentin/harness/commit/a8a68c7f7b28c7406c9e86c59b3e1759a205b9bc))
* install the signal handlers of harness inspect before it prints the URLs ([b880dcb](https://github.com/Vzlentin/harness/commit/b880dcb8841c9bb99ddf3143b539ea9ca8a14cf5))
* let harness page serve the project agent link from a plain Pi session ([c7ba4fb](https://github.com/Vzlentin/harness/commit/c7ba4fb6ae320831754c8b0d2a86a8856b236972))
* let only a spawn write the serves edge of an agent, and a run serve one item ([b4ab93e](https://github.com/Vzlentin/harness/commit/b4ab93e125640e8efc2b55a5ce9c8823095b8c79))
* let Pi run its tool calls with no gate when no host answers, after one question ([b182f60](https://github.com/Vzlentin/harness/commit/b182f60fa2c5e11af6fd5c6e6a0e1ad7a4842a1e))
* let the answer of the user resume an agent that the serving rule ended, and let a terminal stop any conversation ([419feb9](https://github.com/Vzlentin/harness/commit/419feb92f89576282ef227f22e807b070881c9cb))
* make a blank /todo answer a cancel, and refuse /todo in a mirror session ([020f071](https://github.com/Vzlentin/harness/commit/020f071df1df0c75313d98a1982222716804e387))
* make the harness state machines explicit and crash-safe ([#43](https://github.com/Vzlentin/harness/issues/43)) ([b4c8ed7](https://github.com/Vzlentin/harness/commit/b4c8ed750207a8b22bc0a5b51f1366f76256b280))
* name asks by number in the host, and let a take get a contract ([b39d877](https://github.com/Vzlentin/harness/commit/b39d877b9c787d334d7e311a8f91791a22e982bb))
* name the path and the rule of the bad field in an invalid request error ([ba34a7c](https://github.com/Vzlentin/harness/commit/ba34a7cd9c045b6bc5ea461c05b172c791e1609d))
* set the retry timer of a failed push from the clock reading of the sweep ([#49](https://github.com/Vzlentin/harness/issues/49)) ([f28eb84](https://github.com/Vzlentin/harness/commit/f28eb848e7cbbf57ca15ba0ac6fac9de918c28f4))
* split the two request lines of the tools bridge, and raise when a tool gives no structured output ([b14e42c](https://github.com/Vzlentin/harness/commit/b14e42c5942436ab884a979fd1383903417f87c4))


### Performance Improvements

* show the subtrees of live runs only in the tree, and read it without a commit ([30a1280](https://github.com/Vzlentin/harness/commit/30a128096d4bc53ab2317af964e690cd6ab1063a))


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
