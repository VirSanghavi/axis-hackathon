// Grammar binaries, imported as files so `bun build --compile` embeds them in the
// single `axis` binary. At runtime each import is a readable path (on disk in
// development, inside the executable's virtual filesystem when compiled).
import runtime from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import c from "tree-sitter-wasms/out/tree-sitter-c.wasm" with { type: "file" };
import cpp from "tree-sitter-wasms/out/tree-sitter-cpp.wasm" with { type: "file" };
import csharp from "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm" with { type: "file" };
import go from "tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import java from "tree-sitter-wasms/out/tree-sitter-java.wasm" with { type: "file" };
import javascript from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import kotlin from "tree-sitter-wasms/out/tree-sitter-kotlin.wasm" with { type: "file" };
import php from "tree-sitter-wasms/out/tree-sitter-php.wasm" with { type: "file" };
import python from "tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import ruby from "tree-sitter-wasms/out/tree-sitter-ruby.wasm" with { type: "file" };
import rust from "tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
import swift from "tree-sitter-wasms/out/tree-sitter-swift.wasm" with { type: "file" };
import tsx from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import typescript from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };

export const RUNTIME_WASM: string = runtime;

export const GRAMMAR_WASM: Record<string, string> = {
  c,
  cpp,
  csharp,
  go,
  java,
  javascript,
  kotlin,
  php,
  python,
  ruby,
  rust,
  swift,
  tsx,
  typescript,
};
