export default {
    name: 'socket-rewrite',
    description: 'Test fixture: rewrites, drops and injects WebSocket frames.',
    params: { suffix: '-modified' },
    socket: [
        {
            onOpen({ sendToClient }) {
                sendToClient({ event: 'injected-on-open' });
            },
            onServerMessage(message, { params }) {
                if (message.text === 'drop-me') return null;
                if (message.json?.price !== undefined) return { ...message.json, price: message.json.price * 2 };
                return `${message.text}${params.suffix}`;
            },
            onClientMessage(message) {
                return message.text === 'client-rename' ? 'client-renamed' : undefined;
            },
        },
    ],
};
