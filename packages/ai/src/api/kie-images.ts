import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesFunction, ImagesOptions } from "../types.ts";

export const generateImagesKie: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	let prompt = "";
	let imageUrl: string | undefined;
	for (const item of context.input) {
		if (item.type === "text") {
			prompt += (prompt ? "\n" : "") + item.text;
		} else if (item.type === "image") {
			imageUrl = `data:${item.mimeType};base64,${item.data}`;
		}
	}

	const taskInput: Record<string, unknown> = { prompt };
	if (imageUrl) {
		taskInput.image_url = imageUrl;
		taskInput.image_urls = [imageUrl];
	}

	const createRes = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: model.id,
			input: taskInput,
		}),
		signal: options?.signal,
	});

	if (!createRes.ok) {
		throw new Error(`Kie image task creation failed: ${createRes.status} ${await createRes.text()}`);
	}

	const createData = (await createRes.json()) as { code?: number; data?: { taskId?: string }; msg?: string };
	const taskId = createData.data?.taskId;
	if (!taskId) {
		throw new Error(`Kie did not return taskId: ${JSON.stringify(createData)}`);
	}

	const deadline = Date.now() + 180000;
	while (Date.now() < deadline) {
		if (options?.signal?.aborted) {
			output.stopReason = "aborted";
			return output;
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const pollRes = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			signal: options?.signal,
		});
		if (!pollRes.ok) continue;
		const pollData = (await pollRes.json()) as {
			code?: number;
			data?: {
				state?: string;
				result?: { images?: Array<{ url?: string }> | string[] };
				imageUrl?: string;
			};
		};
		const state = (pollData.data?.state || "").toLowerCase();
		if (state === "success" || state === "done") {
			const res = pollData.data?.result;
			const urls: string[] = [];
			if (pollData.data?.imageUrl) {
				urls.push(pollData.data.imageUrl);
			} else if (Array.isArray(res?.images)) {
				for (const img of res.images) {
					if (typeof img === "string") urls.push(img);
					else if (img && typeof img.url === "string") urls.push(img.url);
				}
			}
			for (const url of urls) {
				const imgFetch = await fetch(url, { signal: options?.signal });
				if (imgFetch.ok) {
					const buf = Buffer.from(await imgFetch.arrayBuffer());
					const mimeType = imgFetch.headers.get("content-type") || "image/png";
					output.output.push({
						type: "image",
						data: buf.toString("base64"),
						mimeType,
					});
				}
			}
			return output;
		}
		if (state === "fail" || state === "error") {
			throw new Error(`Kie image task failed: ${JSON.stringify(pollData)}`);
		}
	}
	throw new Error("Kie image task timed out");
};
