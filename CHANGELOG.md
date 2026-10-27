# Changelog

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
