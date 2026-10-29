// Crownforge network settings. Edit and commit to change behaviour for everyone using your GitHub Pages site.
export const CONFIG = {
  // Prefix for room IDs on the PeerJS broker (keeps your rooms separate from other apps on the free public broker).
  peerPrefix: 'crownforge-v1-',

  // null = use PeerJS's built-in defaults (public STUN + PeerJS's free TURN relay).
  // If phones on mobile data can't connect to each other, add your own TURN server here, e.g.:
  // iceServers: [
  //   { urls: 'stun:stun.l.google.com:19302' },
  //   { urls: 'turn:YOUR_TURN_HOST:3478', username: 'USER', credential: 'PASS' },
  // ],
  iceServers: null,

  // null = PeerJS's free public signalling broker (0.peerjs.com). To self-host one:
  // peerServer: { host: 'your-peer-server.example.com', port: 443, path: '/', secure: true },
  peerServer: null,
};
