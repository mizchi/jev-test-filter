/**
 * The environment a test should give a `git` it spawns.
 *
 * A git hook exports GIT_DIR (and friends) to the hook process. pkf's
 * pre-push hook runs this suite, and a test that runs `git init` in a
 * temporary directory with GIT_DIR still set re-initialises the real
 * repository and marks it core.bare = true. Strip every GIT_* variable so
 * the spawned git only ever sees its own cwd.
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}

// Code under test (src/diff.ts, src/run.ts) spawns git with process.env, so
// the variables have to go from this process too. node --test runs each test
// file in its own process, so this does not reach the hook itself.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
