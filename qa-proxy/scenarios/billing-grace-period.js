const DAY_MS = 24 * 60 * 60 * 1000;

export default {
    name: 'billing-grace-period',
    description:
        'Puts the signed-in subscriber into a billing grace period (payment failed, access kept): ' +
        'GET /users/v1/profile returns subscription_status "grace_period" with status_changed_at `daysAgo` days ' +
        'before now. The app only requests this endpoint for a signed-in subscriber; the grace-period banner also ' +
        'needs RC billingBannerEnabled = true. `store` (e.g. "PLAY_STORE") rewrites plan.store in ' +
        'POST /billing/v1/subscription, for a test account whose real subscription comes from another store; ' +
        'when not passed, the real store passes through.',
    params: {
        daysAgo: 3,
    },
    http: [
        {
            method: 'GET',
            path: '/users/v1/profile',
            onResponse(response, { params }) {
                const upstream = response.status < 300 && isObject(response.json) ? response.json : {};
                // The app reads a non-2xx profile as "subscription healthy", so the status is forced to 200.
                return {
                    status: 200,
                    json: {
                        ...upstream,
                        subscription_status: 'grace_period',
                        status_changed_at: new Date(Date.now() - Number(params.daysAgo) * DAY_MS).toISOString(),
                    },
                };
            },
        },
        {
            method: 'POST',
            path: '/billing/v1/subscription',
            onResponse(response, { params }) {
                if (!params.store || response.status >= 300 || !isObject(response.json?.plan)) {
                    return undefined;
                }
                return {
                    json: {
                        ...response.json,
                        plan: { ...response.json.plan, store: String(params.store) },
                    },
                };
            },
        },
    ],
};

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
