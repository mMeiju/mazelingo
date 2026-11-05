/**
 * PLaMo-3 専用の翻訳ユーティリティ。
 *
 * PLaMo-3 は翻訳専用モデルで、JSON スキーマ出力には対応していない。
 * 代わりに 1 文ずつ単純な翻訳リクエストを送り、結果を Mazelingo の
 * TranslationBlock 形式（sentences 配列）に組み立てて返す。
 */

import type { IndexedBlock, TranslationBlock } from "./messages";
import type { ReadonlyConfig, ReadonlyTranslationBlock } from "./translate-core";

/** HTML タグを除去してプレーンテキストを取り出す。 */
function stripHtml(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, "").trim();
}

/**
 * PLaMo llama-server のエンドポイント URL
 */
function resolveEndpoint(): string {
  return "http://127.0.0.1:8080/v1/chat/completions";
}

/** llama-server の /v1/models から最初のモデル ID を取得する。失敗時はフォールバック。 */
let _cachedModelName: string | null = null;
async function fetchFirstModelName(): Promise<string> {
  if (_cachedModelName !== null) {
    return _cachedModelName;
  }
  try {
    const res = await fetch("http://127.0.0.1:8080/v1/models");
    if (!res.ok) {
      _cachedModelName = "pfnet/plamo-3-translate-0.8b-GGUF";
      return _cachedModelName;
    }
    interface ModelsShape {
      data?: { id?: string }[];
    }
    const json = (await res.json()) as ModelsShape;
    _cachedModelName = json.data?.[0]?.id ?? "pfnet/plamo-3-translate-0.8b-GGUF";
  } catch {
    _cachedModelName = "pfnet/plamo-3-translate-0.8b-GGUF";
  }
  return _cachedModelName;
}

/**
 * PLaMo-3 に 1 つのテキストを翻訳させ、翻訳結果文字列を返す。
 */
async function plamoTranslateOne(
  text: string,
  fromName: string,
  toName: string,
  modelName: string,
): Promise<string> {
  const bare = stripHtml(text);
  if (bare === "") {
    return text;
  }

  const targetCode = (toName.toLowerCase().includes("en") || toName === "English") ? "en" : "ja";
  const targetLangName = targetCode === "en" ? "English" : "Japanese";

  let requestModel = modelName.replace(/^local\//, "").trim();
  if (requestModel === "auto" || requestModel === "") {
    requestModel = await fetchFirstModelName();
  }

  const body = {
    model: requestModel,
    messages: [
      { role: "system", content: `Translate the following text into ${targetLangName} (${targetCode}).` },
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
    const errText = await response.text();
    throw new Error(`PLaMo translate failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  interface OpenAIShape {
    choices?: { message?: { content?: string } }[];
  }
  const data = (await response.json()) as OpenAIShape;
  const translated = data.choices?.[0]?.message?.content?.trim();
  return translated || bare;
}

/**
 * 日本語または英語の文末記号で簡易分割する
 */
function splitSentences(text: string): string[] {
  // 句点・ピリオド・感嘆符・疑問符で分割（区切り文字を直前の文に含める）
  const parts = text.split(/(?<=[。！？\n]|(?<!\.[a-zA-Z0-9])\.\s+)/u);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * PLaMo-3 で IndexedBlock の配列を翻訳し、ReadonlyTranslationBlock の配列を返す。
 * 各ブロック内の文を分割して個別に翻訳することで、Mazelingo のきめ細かな
 * バイリンガルミックス表示を実現する。
 */
export async function plamoTranslateBatch(
  blocks: ReadonlyArray<Readonly<IndexedBlock>>,
  fromName: string,
  toName: string,
  config: Readonly<ReadonlyConfig>,
): Promise<ReadonlyArray<ReadonlyTranslationBlock | null>> {
  const modelName =
    config.models.find((m: string) => m.startsWith("local/plamo")) ??
    config.models.find((m: string) => m.startsWith("local/pfnet/")) ??
    config.models.find((m: string) => m.startsWith("local/")) ??
    "local/auto";

  const results = await Promise.all(
    blocks.map(async (block): Promise<ReadonlyTranslationBlock | null> => {
      try {
        const bare = stripHtml(block.html);
        if (bare === "") {
          return { sentences: [{ source: block.html, translation: block.html }] };
        }

        const sentenceParts = splitSentences(bare);
        if (sentenceParts.length <= 1) {
          const translation = await plamoTranslateOne(bare, fromName, toName, modelName);
          return {
            sentences: [{ source: block.html, translation }],
          };
        }

        // 複数文ある場合は各文を翻訳
        const sentences = await Promise.all(
          sentenceParts.map(async (part) => {
            const translation = await plamoTranslateOne(part, fromName, toName, modelName);
            return { source: part, translation };
          }),
        );

        return { sentences };
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
 */
export function hasPlamoModel(models: readonly string[]): boolean {
  return models.some(
    (m: string) =>
      m.startsWith("local/plamo") ||
      m.startsWith("local/pfnet/") ||
      m === "local/auto" ||
      m.startsWith("local/"),
  );
}
