/**
 * Provider balance fetcher — polls API-key providers for residual balance.
 *
 * Only providers with a known balance endpoint are polled. The result is cached
 * with a 5-minute TTL; the status line segment reads the cache synchronously.
 *
 * Supported providers:
 * - DeepSeek: GET {baseUrl}/user/balance → { balance_infos: [{ total_balance, currency }] }
 *
 * Subscription providers (OpenAI Codex, Z.AI) use the separate `usage` segment
 * (5h/7d windows via auth-broker). API-key providers without a balance endpoint
 * (a6api, tokenrouter) simply return null — nothing is displayed.
 */

export interface ProviderBalance {
	provider: string;
	amount: number;
	currency: string;
	fetchedAt: number;
}

const BALANCE_TTL_MS = 5 * 60_000;
const BALANCE_TIMEOUT_MS = 8_000;

/**
 * Resolve the balance API path for a provider, or null if unsupported.
 * Known endpoints:
 * - DeepSeek: /user/balance
 */
export function resolveBalancePath(provider: string, baseUrl: string): string | null {
	const host = baseUrl.replace(/^https?:\/\//, "").replace(/\/v\d+\/?.*$/, "");

	if (provider === "deepseek" || host.includes("api.deepseek.com")) return "/user/balance";
	return null;
}

/** A provider exposes a balance API when we know the endpoint path. */
export function isBalanceSupported(provider: string, baseUrl: string): boolean {
	return resolveBalancePath(provider, baseUrl) !== null;
}

interface DeepSeekBalanceResponse {
	is_available?: boolean;
	balance_infos?: Array<{
		currency?: string;
		total_balance?: string;
		granted_balance?: string;
		topped_up_balance?: string;
	}>;
}

function isDeepSeekBalanceResponse(value: unknown): value is DeepSeekBalanceResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(!("balance_infos" in value) || Array.isArray((value as DeepSeekBalanceResponse).balance_infos))
	);
}

/**
 * Fetch the residual balance for a provider. Returns null if the provider has
 * no known balance endpoint or the request fails.
 */
export async function fetchProviderBalance(
	provider: string,
	baseUrl: string,
	apiKey: string,
): Promise<ProviderBalance | null> {
	const path = resolveBalancePath(provider, baseUrl);
	if (!path || !apiKey) return null;

	const url = baseUrl.replace(/\/+$/, "") + path;

	try {
		const resp = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
		});
		if (!resp.ok) return null;

		const data: unknown = await resp.json();
		if (!isDeepSeekBalanceResponse(data) || !data.balance_infos?.length) return null;

		const info = data.balance_infos[0];
		const amount = parseFloat(info.total_balance ?? "");
		if (!Number.isFinite(amount)) return null;

		return {
			provider,
			amount,
			currency: info.currency ?? "USD",
			fetchedAt: Date.now(),
		};
	} catch {
		return null;
	}
}

/** Returns true if a cached balance is still fresh enough to display. */
export function isBalanceFresh(cached: ProviderBalance | null): boolean {
	if (!cached) return false;
	return Date.now() - cached.fetchedAt < BALANCE_TTL_MS;
}
