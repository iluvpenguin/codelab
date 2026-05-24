import axios from "axios";

// Read lazily on each call so Electron's did-finish-load injection works.
function getBackendUrl() {
  return (
    window.__BACKEND_URL__ ||
    process.env.REACT_APP_BACKEND_URL ||
    "http://localhost:58483"
  );
}

const api = axios.create({ timeout: 30000 });

api.interceptors.request.use((config) => {
  if (!config.baseURL) config.baseURL = getBackendUrl();
  return config;
});

// Named export kept for CollabPanel / AIPanel / Terminal / EditorPane
// which build WebSocket URLs and raw fetch calls from it.
// They call this as a function: getBackendUrl()
export { getBackendUrl as BACKEND_URL };
export default api;
