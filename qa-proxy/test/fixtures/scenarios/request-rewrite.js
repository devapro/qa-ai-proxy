export default {
    name: 'request-rewrite',
    description: 'Test fixture: rewrites a request and short-circuits another.',
    http: [
        {
            method: 'POST',
            path: '/echo-body',
            onRequest(request) {
                return { json: { ...request.json, injected: true } };
            },
        },
        {
            path: '/never-reaches-server',
            onRequest() {
                return { respond: { status: 418, json: { short: 'circuit' } } };
            },
        },
        {
            path: '/broken',
            onResponse() {
                throw new Error('scenario bug');
            },
        },
    ],
};
