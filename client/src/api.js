export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    const error = new Error('Could not reach the server.');
    error.code = 'NETWORK';
    throw error;
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const error = new Error('The server returned a response we could not read.');
      error.status = response.status;
      throw error;
    }
  }
  if (!response.ok) {
    const error = new Error(data?.error || 'The request failed.');
    error.status = response.status;
    error.code = data?.code;
    error.productName = data?.productName;
    throw error;
  }
  return data;
}
