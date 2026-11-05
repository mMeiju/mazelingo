/**
 * PLaMo-3 専用の翻訳ユーティリティ。
 *
 * PLaMo-3 は翻訳専用モデルで、JSON スキーマ出力には対応していない。
 * 代わりに 1 文ずつ単純な翻訳リクエストを送り、結果を Mazelingo の
 * TranslationBlock 形式（sentences 配列）に組み立てて返す。
 *
 * 呼び出し条件: モデル名が "local/plamo" から始まる場合に使用する。
 */

import type { IndexedBlock, TranslationBlock } from "./messages";
import type { ReadonlyConfig, ReadonlyTranslationBlock } from "./translate-core";

/** HTML タグを除去してプレーンテキストを取り出す。 */
function stripHtml(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, "").trim();
}

/**
 * PLaMo llama-server のエンドポイント URL をモデル名から解決する。
 * "local/auto" の場合は model フィールドに "auto" を送る。
 */
function resolveEndpoint(): string {
  return "http://127.0.0.1:8080/v1/chat/completions";
}

/**
 * PLaMo-3 に 1 つのテキストを翻訳させ、翻訳結果文字列を返す。
 * PLaMo-3 は system メッセージで翻訳先言語を指定する独自テンプレートを使う。
 */
async function plamoTranslateOne(
  text: string,
  fromName: string,
  toName: string,
  modelName: string,
): Promise<string> {
  const bare = stripHtml(text);
  if (bare === "") {
    return text; // 空テキストはそのまま返す
  }
  // PLaMo の chat_template.jinja は system メッセージの内容で
  // 翻訳先言語コードを判定する ("en" / "ja")。
  const targetCode = toName === "English" ? "en" : "ja";
  const requestModel = modelName.replace(/^local\//, "") || "auto";
  const body = {
    model: requestModel,
    messages: [
      { role: "system", content: `Translate the following text into ${toName} (${targetCode}).` },
      { role: "user", content: bare },
    ],
    temperature: 0,
  };
  const response = await fetch(resolveEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PLaMo translate failed (${response.status}): ${text.slice(0, 200)}`);
  }
  interface OpenAIShape {
    choices?: { message?: { content?: string } }[];
  }
  const data = (await response.json()) as OpenAIShape;
  return data.choices?.[0]?.message?.content?.trim() ?? bare;
}

/**
 * PLaMo-3 で IndexedBlock の配列を翻訳し、ReadonlyTranslationBlock の配列を返す。
 * 各ブロックは 1 文として扱い、並列翻訳する。
 */
export async function plamoTranslateBatch(
  blocks: ReadonlyArray<Readonly<IndexedBlock>>,
  fromName: string,
  toName: string,
  config: Readonly<ReadonlyConfig>,
): Promise<ReadonlyArray<ReadonlyTranslationBlock | null>> {
  // モデル名を config.models から "local/plamo*" のものを探す
  const modelName =
    config.models.find((m: string) => m.startsWith("local/plamo")) ??
    config.models.find((m: string) => m.startsWith("local/")) ??
    "local/auto";

  const results = await Promise.all(
    blocks.map(async (block): Promise<ReadonlyTranslationBlock | null> => {
      try {
        const translation = await plamoTranslateOne(block.html, fromName, toName, modelName);
        const result: TranslationBlock = {
          sentences: [{ source: block.html, translation }],
        };
        return result;
      } catch (error) {
        console.warn("[mlg:plamo] block translation failed", {
          i: block.i,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );
  return results;
}

/**
 * モデルリストに PLaMo 専用パスを使うべきモデルが含まれているか判定する。
 * "local/plamo" か "local/auto" が含まれていれば true。
 * ("local/auto" は起動中のモデルが PLaMo かもしれないため含める)
 */
export function hasPlamoModel(models: readonly string[]): boolean {
  return models.some(
    (m: string) => m.startsWith("local/plamo") || m === "local/auto",
  );
}
