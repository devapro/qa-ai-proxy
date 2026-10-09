export default {
    name: 'quote-stream-halt',
    description:
        'Makes one instrument look halted on the live-quote socket (wss://stream.example.com/quotes): price ' +
        'frames for `symbol` are dropped, and right after the socket opens the app receives a ' +
        '{"type":"status","symbol":...,"status":"halted"} frame. Every other symbol, heartbeat and subscription ' +
        'frame stays real. The app shows the "Trading halted" badge on that instrument\'s screen; it needs the ' +
        'instrument in the user\'s watchlist so the app subscribes to it.',
    params: {
        symbol: 'AAPL',
    },
    socket: [
        {
            path: '/quotes',
            onOpen({ params, sendToClient }) {
                sendToClient({ type: 'status', symbol: String(params.symbol), status: 'halted' });
            },
            onServerMessage(message, { params }) {
                if (message.json?.type === 'price' && message.json.symbol === String(params.symbol)) {
                    return null;
                }
                return undefined;
            },
        },
    ],
};
