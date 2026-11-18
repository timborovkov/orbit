/** Create a blob URL and return it with a paired revoke for the same string. */
export function createBlobUrl(file: Blob): { url: string; revoke: () => void } {
  const url = URL.createObjectURL(file);
  return {
    url,
    revoke: () => {
      URL.revokeObjectURL(url);
    },
  };
}