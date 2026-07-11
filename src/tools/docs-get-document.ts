import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { docs_v1 } from 'googleapis';
import { getDocsClient } from '../docs/client.js';
import { withRetry } from '../gmail/client.js';

export const getGoogleDocParams = {
  document_id: z.string().describe('The Google Docs document id to read.'),
  account: z.string().optional().describe('Account alias or email address. Uses default account if not specified.'),
};

/**
 * Flatten a paragraph's text runs into a single line of text.
 */
function paragraphText(paragraph: docs_v1.Schema$Paragraph): string {
  const parts: string[] = [];
  for (const el of paragraph.elements || []) {
    const content = el.textRun?.content;
    if (content) parts.push(content);
  }
  return parts.join('');
}

/**
 * Recursively flatten a list of structural elements (paragraphs + tables)
 * into readable plain text. Table cells are joined with tabs, rows by newline.
 */
function flattenStructuralElements(elements: docs_v1.Schema$StructuralElement[] | undefined): string {
  if (!elements) return '';
  const out: string[] = [];

  for (const el of elements) {
    if (el.paragraph) {
      out.push(paragraphText(el.paragraph));
    } else if (el.table) {
      for (const row of el.table.tableRows || []) {
        const cells: string[] = [];
        for (const cell of row.tableCells || []) {
          cells.push(flattenStructuralElements(cell.content).trim());
        }
        out.push(cells.join('\t'));
      }
    }
    // sectionBreak / tableOfContents contribute no body text.
  }

  return out.join('');
}

/**
 * READ-ONLY: fetch a Google Doc and return its title + flattened plain text.
 */
export function registerGetGoogleDoc(server: McpServer): void {
  server.tool(
    'get_google_doc',
    'Read a Google Doc by document id and return its title plus the body flattened into readable plain text (paragraphs and tables). Read-only.',
    getGoogleDocParams,
    async ({ document_id, account }) => {
      try {
        const docs = await getDocsClient(account ?? undefined);

        const response = await withRetry(() =>
          docs.documents.get({ documentId: document_id })
        );
        const doc = response.data;

        const title = doc.title || '(untitled)';
        const text = flattenStructuralElements(doc.body?.content);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  documentId: doc.documentId,
                  title,
                  text: `${title}\n\n${text}`.trimEnd(),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
