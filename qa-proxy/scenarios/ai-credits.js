const CREDITS_PATH = '/assistant/v1/credits';

export default {
    name: 'ai-credits',
    description:
        'Sets the AI-assistant credit balance: GET /assistant/v1/credits returns credits_left = `left`, ' +
        'request_cost = `cost` and can_run = left >= cost; an error upstream becomes a 200 with those fields. ' +
        'With `fail` = true the endpoint answers HTTP 500 instead, and the app shows its generic error dialog. ' +
        'The app only requests the balance when a signed-in user taps "Ask AI", which needs RC aiAssistantEnabled = ' +
        'true; the account tier decides which out-of-credits UI shows and is arranged separately. When the balance ' +
        'is sufficient the app goes on to call the real /assistant/v1/chat, so the real account must be allowed to.',
    params: {
        left: 50,
        cost: 5,
        fail: false,
    },
    http: [
        {
            method: 'GET',
            path: CREDITS_PATH,
            onResponse(response, { params }) {
                if (params.fail === true || params.fail === 'true') {
                    return { status: 500, json: { detail: 'qa-proxy ai-credits: forced failure' } };
                }
                const left = toInt(params.left, 'left');
                const cost = toInt(params.cost, 'cost');
                const upstream = response.status < 300 && isObject(response.json) ? response.json : {};
                return {
                    status: 200,
                    json: { ...upstream, credits_left: left, request_cost: cost, can_run: left >= cost },
                };
            },
        },
    ],
};

function toInt(value, name) {
    const number = Number(value);
    if (!Number.isInteger(number)) {
        throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
    }
    return number;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
