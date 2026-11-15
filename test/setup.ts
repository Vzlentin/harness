import { devNull } from "node:os";

// A caller such as `git rebase -x` or a Git hook exports `GIT_DIR` and `GIT_WORK_TREE`.
// The tests and the children they start must not run Git in the caller's repository,
// and must not read the user's or the system's Git configuration.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("GIT_")) delete process.env[name];
}

Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: devNull,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
});
