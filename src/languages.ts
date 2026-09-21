/**
 * The grammars ast-grep does not bundle.
 *
 * `@ast-grep/napi` ships the web languages only; Rust and Go arrive as
 * separate packages and have to be registered before the first `parse` that
 * names them. Registration is process-wide and rejects a second call for the
 * same language, so it happens once behind a flag rather than per file.
 */
import { registerDynamicLanguage } from "@ast-grep/napi";
import rust from "@ast-grep/lang-rust";
import go from "@ast-grep/lang-go";

let registered = false;

export function registerLanguages(): void {
  if (registered) return;
  registerDynamicLanguage({ rust, go });
  registered = true;
}
