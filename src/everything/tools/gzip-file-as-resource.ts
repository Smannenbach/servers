import { z } from "zod";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult, Resource } from "@modelcontextprotocol/sdk/types.js";
import { gzipSync } from "node:zlib";
import {
  getSessionResourceURI,
  registerSessionResource,
} from "../resources/session.js";

// Maximum input file size - 10 MB default
const GZIP_MAX_FETCH_SIZE = Number(
  process.env.GZIP_MAX_FETCH_SIZE ?? String(10 * 1024 * 1024)
);

// Maximum fetch time - 30 seconds default.
const GZIP_MAX_FETCH_TIME_MILLIS = Number(
  process.env.GZIP_MAX_FETCH_TIME_MILLIS ?? String(30 * 1000)
);

// Comma-separated list of allowed domains. Empty disables remote fetching.
const GZIP_ALLOWED_DOMAINS = (process.env.GZIP_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter((d) => d.length > 0);

const GZIP_MAX_REDIRECTS = 5;
const BLOCKED_ADDRESS_RANGES = new BlockList();

BLOCKED_ADDRESS_RANGES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("198.18.0.0", 15, "ipv4");
BLOCKED_ADDRESS_RANGES.addSubnet("::", 128, "ipv6");
BLOCKED_ADDRESS_RANGES.addSubnet("::1", 128, "ipv6");
BLOCKED_ADDRESS_RANGES.addSubnet("fc00::", 7, "ipv6");
BLOCKED_ADDRESS_RANGES.addSubnet("fe80::", 10, "ipv6");

// Tool input schema
const GZipFileAsResourceSchema = z.object({
  name: z.string().describe("Name of the output file").default("README.md.gz"),
  data: z
    .url()
    .describe(
      "Data URI or HTTPS URL of the file content to compress. Remote URLs must match GZIP_ALLOWED_DOMAINS."
    )
    .default(
      "https://raw.githubusercontent.com/modelcontextprotocol/servers/refs/heads/main/README.md"
    ),
  outputType: z
    .enum(["resourceLink", "resource"])
    .default("resourceLink")
    .describe(
      "How the resulting gzipped file should be returned. 'resourceLink' returns a link to a resource that can be read later, 'resource' returns a full resource object."
    ),
});

// Tool configuration
const name = "gzip-file-as-resource";
const config = {
  title: "GZip File as Resource Tool",
  description:
    "Compresses a single file using gzip compression. Depending upon the selected output type, returns either the compressed data as a gzipped resource or a resource link, allowing it to be downloaded in a subsequent request during the current session.",
  inputSchema: GZipFileAsResourceSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/**
 * Registers the `gzip-file-as-resource` tool.
 *
 * The registered tool compresses input data using gzip, and makes the resulting file accessible
 * as a resource for the duration of the session.
 *
 * The tool supports two output types:
 * - "resource": Returns the resource directly, including its URI, MIME type, and base64-encoded content.
 * - "resourceLink": Returns a link to access the resource later.
 *
 * If an unrecognized `outputType` is provided, the tool throws an error.
 *
 * @param {McpServer} server - The McpServer instance where the tool will be registered.
 * @throws {Error} Throws an error if an unknown output type is specified.
 */
export const registerGZipFileAsResourceTool = (server: McpServer) => {
  server.registerTool(name, config, async (args): Promise<CallToolResult> => {
    const {
      name,
      data: dataUri,
      outputType,
    } = GZipFileAsResourceSchema.parse(args);

    // Validate data uri
    const url = validateDataURI(dataUri);

    // Fetch the data
    const response = await fetchSafely(url, {
      maxBytes: GZIP_MAX_FETCH_SIZE,
      timeoutMillis: GZIP_MAX_FETCH_TIME_MILLIS,
    });

    // Compress the data using gzip
    const inputBuffer = Buffer.from(response);
    const compressedBuffer = gzipSync(inputBuffer);

    // Create resource
    const uri = getSessionResourceURI(name);
    const blob = compressedBuffer.toString("base64");
    const mimeType = "application/gzip";
    const resource = <Resource>{ uri, name, mimeType };

    // Register resource, get resource link in return
    const resourceLink = registerSessionResource(
      server,
      resource,
      "blob",
      blob
    );

    // Return the resource or a resource link that can be used to access this resource later
    if (outputType === "resource") {
      return {
        content: [
          {
            type: "resource",
            resource: { uri, mimeType, blob },
          },
        ],
      };
    } else if (outputType === "resourceLink") {
      return {
        content: [resourceLink],
      };
    } else {
      throw new Error(`Unknown outputType: ${outputType}`);
    }
  });
};

/**
 * Validates a given data URI to ensure it follows the appropriate protocols and rules.
 *
 * @param {string} dataUri - The URI to validate. Must be a data URI or an allowlisted HTTPS URL.
 * @return {URL} The validated and parsed URL object.
 * @throws {Error} If the data URI does not use a supported protocol or does not meet allowed domains criteria.
 */
function validateDataURI(dataUri: string): URL {
  // Validate Inputs
  const url = new URL(dataUri);
  try {
    if (url.protocol !== "https:" && url.protocol !== "data:") {
      throw new Error(
        `Unsupported URL protocol for ${dataUri}. Only https and data URLs are supported.`
      );
    }
    if (url.protocol === "https:") {
      const domain = url.hostname;
      if (GZIP_ALLOWED_DOMAINS.length === 0) {
        throw new Error(
          "Remote fetches are disabled unless GZIP_ALLOWED_DOMAINS is configured."
        );
      }
      if (isLocalHostname(domain)) {
        throw new Error(`Host ${domain} is not allowed.`);
      }
      if (!isDomainAllowed(domain)) {
        throw new Error(`Domain ${domain} is not in the allowed domains list.`);
      }
      if (isBlockedAddress(domain)) {
        throw new Error(`Host ${domain} resolves to a blocked address.`);
      }
    }
  } catch (error) {
    throw new Error(
      `Error processing file ${dataUri}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return url;
}

function isDomainAllowed(domain: string): boolean {
  const normalizedDomain = domain.toLowerCase();
  return GZIP_ALLOWED_DOMAINS.some((allowedDomain) => {
    return (
      normalizedDomain === allowedDomain ||
      normalizedDomain.endsWith(`.${allowedDomain}`)
    );
  });
}

function isLocalHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost")
  );
}

function isBlockedAddress(address: string): boolean {
  const mappedIpv4Prefix = "::ffff:";
  if (address.toLowerCase().startsWith(mappedIpv4Prefix)) {
    return isBlockedAddress(address.slice(mappedIpv4Prefix.length));
  }

  const addressType = isIP(address);
  if (addressType === 4) {
    return BLOCKED_ADDRESS_RANGES.check(address, "ipv4");
  }
  if (addressType === 6) {
    return BLOCKED_ADDRESS_RANGES.check(address, "ipv6");
  }
  return false;
}

async function validateResolvedAddress(url: URL): Promise<void> {
  if (url.protocol !== "https:") {
    return;
  }

  let resolvedAddresses: Awaited<ReturnType<typeof lookup>>;
  try {
    resolvedAddresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(
      `Unable to resolve ${url.hostname}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!resolvedAddresses.length) {
    throw new Error(`Unable to resolve ${url.hostname}`);
  }

  for (const { address } of resolvedAddresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Host ${url.hostname} resolves to a blocked address.`);
    }
  }
}

/**
 * Fetches data safely from a given URL while ensuring constraints on maximum byte size and timeout duration.
 *
 * @param {URL} url The URL to fetch data from.
 * @param {Object} options An object containing options for the fetch operation.
 * @param {number} options.maxBytes The maximum allowed size (in bytes) of the response. If the response exceeds this size, the operation will be aborted.
 * @param {number} options.timeoutMillis The timeout duration (in milliseconds) for the fetch operation. If the fetch takes longer, it will be aborted.
 * @return {Promise<ArrayBuffer>} A promise that resolves with the response as an ArrayBuffer if successful.
 * @throws {Error} Throws an error if the response size exceeds the defined limit, the fetch times out, or the response is otherwise invalid.
 */
async function fetchSafely(
  url: URL,
  { maxBytes, timeoutMillis }: { maxBytes: number; timeoutMillis: number }
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        `Fetching ${url} took more than ${timeoutMillis} ms and was aborted.`
      ),
    timeoutMillis
  );

  try {
    let currentUrl = new URL(url);
    for (let redirectCount = 0; redirectCount <= GZIP_MAX_REDIRECTS; redirectCount++) {
      await validateResolvedAddress(currentUrl);

      // Fetch the data
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount === GZIP_MAX_REDIRECTS) {
          throw new Error(`Too many redirects while fetching ${url}`);
        }

        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect response from ${currentUrl} did not include a location header`);
        }

        currentUrl = validateDataURI(new URL(location, currentUrl).toString());
        continue;
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch ${currentUrl}: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      // Note: we can't trust the Content-Length header: a malicious or clumsy server could return much more data than advertised.
      // We check it here for early bail-out, but we still need to monitor actual bytes read below.
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader != null) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (contentLength > maxBytes) {
          throw new Error(
            `Content-Length for ${currentUrl} exceeds max of ${maxBytes}: ${contentLength}`
          );
        }
      }

      // Read the fetched data from the response body
      const reader = response.body.getReader();
      const chunks = [];
      let totalSize = 0;

      // Read chunks until done
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalSize += value.length;

          if (totalSize > maxBytes) {
            reader.cancel();
            throw new Error(`Response from ${currentUrl} exceeds ${maxBytes} bytes`);
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      // Combine chunks into a single buffer
      const buffer = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }

      return buffer.buffer;
    }
    throw new Error(`Too many redirects while fetching ${url}`);
  } finally {
    clearTimeout(timeout);
  }
}
