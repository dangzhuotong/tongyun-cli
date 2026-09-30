import { generateImagesKie } from "../api/kie-images.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model, OpenAICompletionsCompat } from "../types.ts";
import { KIE_IMAGE_MODELS, KIE_MODELS } from "./kie.models.ts";

const DEFAULT_KIE_BASE_URL = "https://api.kie.ai/v1";

const defaultKieCompat: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsLongCacheRetention: false,
};

interface KieModelItem {
	id: string;
	name?: string;
	created?: number;
	owned_by?: string;
}

interface KieModelsResponse {
	data?: KieModelItem[];
}

export function kieProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "kie",
		name: "Kie.ai",
		baseUrl: DEFAULT_KIE_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Kie.ai API key", ["KIE_API_KEY"]) },
		models: [...Object.values(KIE_MODELS), ...Object.values(KIE_IMAGE_MODELS)],
		fetchModels: async (context) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (!apiKey) return [];
			try {
				const response = await fetch(`${DEFAULT_KIE_BASE_URL}/models`, {
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					signal: context.signal,
				});
				if (!response.ok) return [];
				const result = (await response.json()) as KieModelsResponse;
				if (!Array.isArray(result.data)) return [];

				const baselineMap = new Map<string, Model<"openai-completions">>(
					Object.values(KIE_MODELS).map((m) => [m.id, m]),
				);
				const dynamicModels: Model<"openai-completions">[] = [];

				for (const item of result.data) {
					if (!item.id || typeof item.id !== "string") continue;
					const existing = baselineMap.get(item.id);
					if (existing) {
						dynamicModels.push(existing);
						continue;
					}
					const isReasoning = /reasoner|r1|o1|o3|thinking/i.test(item.id);
					const isVision = /gpt-4o|claude-3|gemini|flux|vision|vl/i.test(item.id);
					const compat: OpenAICompletionsCompat = isReasoning
						? { ...defaultKieCompat, thinkingFormat: "deepseek" }
						: defaultKieCompat;

					dynamicModels.push({
						id: item.id,
						name: item.name || item.id,
						api: "openai-completions",
						baseUrl: DEFAULT_KIE_BASE_URL,
						provider: "kie",
						reasoning: isReasoning,
						input: isVision ? ["text", "image"] : ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
						compat,
					});
				}
				return dynamicModels;
			} catch {
				return [];
			}
		},
		api: openAICompletionsApi(),
		images: {
			"kie-images": { generateImages: generateImagesKie },
		},
	});
}
