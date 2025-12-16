/**
 * Export Formats - Convert reports to various file formats
 */

import { writeFile } from 'fs/promises';
import { marked } from 'marked';

export type ExportFormat = 'markdown' | 'pdf' | 'docx' | 'html' | 'txt';

export interface ExportOptions {
    title?: string;
    format: ExportFormat;
    outputPath: string;
}

/**
 * Get file extension for a format
 */
export function getExtension(format: ExportFormat): string {
    switch (format) {
        case 'markdown': return '.md';
        case 'pdf': return '.pdf';
        case 'docx': return '.docx';
        case 'html': return '.html';
        case 'txt': return '.txt';
    }
}

/**
 * Get format display name
 */
export function getFormatName(format: ExportFormat): string {
    switch (format) {
        case 'markdown': return 'Markdown';
        case 'pdf': return 'PDF';
        case 'docx': return 'Word Document';
        case 'html': return 'HTML';
        case 'txt': return 'Plain Text';
    }
}

/**
 * Export content to specified format
 */
export async function exportReport(
    content: string,
    options: ExportOptions
): Promise<void> {
    const { format, outputPath, title } = options;

    switch (format) {
        case 'markdown':
            await exportMarkdown(content, outputPath);
            break;
        case 'html':
            await exportHtml(content, outputPath, title);
            break;
        case 'txt':
            await exportPlainText(content, outputPath);
            break;
        case 'docx':
            await exportDocx(content, outputPath, title);
            break;
        case 'pdf':
            await exportPdf(content, outputPath, title);
            break;
    }
}

/**
 * Export as Markdown (just save as-is)
 */
async function exportMarkdown(content: string, outputPath: string): Promise<void> {
    await writeFile(outputPath, content, 'utf-8');
}

/**
 * Export as HTML
 */
async function exportHtml(content: string, outputPath: string, title?: string): Promise<void> {
    const htmlContent = await marked.parse(content);
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title || 'Research Report'}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
            line-height: 1.6;
            color: #333;
        }
        h1, h2, h3 { color: #1a1a1a; margin-top: 2rem; }
        h1 { border-bottom: 2px solid #6b46c1; padding-bottom: 0.5rem; }
        h2 { border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3rem; }
        code { background: #f1f5f9; padding: 0.2rem 0.4rem; border-radius: 4px; }
        pre { background: #f1f5f9; padding: 1rem; border-radius: 8px; overflow-x: auto; }
        blockquote { border-left: 4px solid #6b46c1; margin-left: 0; padding-left: 1rem; color: #666; }
        a { color: #6b46c1; }
        ul, ol { padding-left: 1.5rem; }
        li { margin: 0.5rem 0; }
    </style>
</head>
<body>
${htmlContent}
</body>
</html>`;

    await writeFile(outputPath, fullHtml, 'utf-8');
}

/**
 * Export as plain text (strip markdown)
 */
async function exportPlainText(content: string, outputPath: string): Promise<void> {
    // Simple markdown stripping
    let plainText = content
        // Remove headers markers
        .replace(/^#{1,6}\s+/gm, '')
        // Remove bold/italic
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/_(.+?)_/g, '$1')
        // Remove links, keep text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // Remove images
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        // Remove code blocks
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        // Remove blockquotes
        .replace(/^>\s+/gm, '')
        // Remove horizontal rules
        .replace(/^---+$/gm, '')
        // Clean up extra whitespace
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    await writeFile(outputPath, plainText, 'utf-8');
}

/**
 * Export as Word document (DOCX)
 */
async function exportDocx(content: string, outputPath: string, title?: string): Promise<void> {
    const { Document, Paragraph, TextRun, HeadingLevel, Packer } = await import('docx');

    // Helper to parse bold/italic text into TextRuns
    const parseTextRuns = (text: string, TextRunClass: typeof TextRun): InstanceType<typeof TextRun>[] => {
        const runs: InstanceType<typeof TextRun>[] = [];
        const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|_(.+?)_|[^*_]+)/g;
        let match;

        while ((match = pattern.exec(text)) !== null) {
            const fullMatch = match[0];

            if (fullMatch.startsWith('**') || fullMatch.startsWith('__')) {
                runs.push(new TextRunClass({
                    text: match[2] || match[4],
                    bold: true,
                }));
            } else if (fullMatch.startsWith('*') || fullMatch.startsWith('_')) {
                runs.push(new TextRunClass({
                    text: match[3] || match[5],
                    italics: true,
                }));
            } else {
                runs.push(new TextRunClass({ text: fullMatch }));
            }
        }

        if (runs.length === 0) {
            runs.push(new TextRunClass({ text }));
        }

        return runs;
    };

    // Parse markdown into sections
    const lines = content.split('\n');
    const children: any[] = [];

    // Add title if provided
    if (title) {
        children.push(new Paragraph({
            text: title,
            heading: HeadingLevel.TITLE,
            spacing: { after: 400 },
        }));
    }

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('# ')) {
            children.push(new Paragraph({
                text: trimmed.slice(2),
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 400, after: 200 },
            }));
        } else if (trimmed.startsWith('## ')) {
            children.push(new Paragraph({
                text: trimmed.slice(3),
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 300, after: 150 },
            }));
        } else if (trimmed.startsWith('### ')) {
            children.push(new Paragraph({
                text: trimmed.slice(4),
                heading: HeadingLevel.HEADING_3,
                spacing: { before: 250, after: 100 },
            }));
        } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            // Parse bold/italic in list items
            const listText = trimmed.slice(2);
            const listRuns = parseTextRuns(listText, TextRun);
            children.push(new Paragraph({
                children: listRuns,
                bullet: { level: 0 },
            }));
        } else if (/^\d+\.\s/.test(trimmed)) {
            const listText = trimmed.replace(/^\d+\.\s/, '');
            const listRuns = parseTextRuns(listText, TextRun);
            children.push(new Paragraph({
                children: listRuns,
                numbering: { level: 0, reference: 'default-numbering' },
            }));
        } else if (trimmed === '') {
            // Empty line - add spacing
            children.push(new Paragraph({ text: '' }));
        } else {
            // Regular paragraph - handle bold and italic
            const runs = parseTextRuns(trimmed, TextRun);
            children.push(new Paragraph({ children: runs }));
        }
    }

    const doc = new Document({
        sections: [{
            properties: {},
            children,
        }],
        numbering: {
            config: [{
                reference: 'default-numbering',
                levels: [{
                    level: 0,
                    format: 'decimal' as any,
                    text: '%1.',
                    alignment: 'left' as any,
                    style: {
                        paragraph: {
                            indent: { left: 720, hanging: 360 },
                        },
                    },
                }],
            }],
        },
    });

    const buffer = await Packer.toBuffer(doc);
    await writeFile(outputPath, buffer);
}

/**
 * Export as PDF - generates HTML and notes that it can be printed to PDF
 * (Full PDF generation would require puppeteer or similar, which is heavy)
 */
async function exportPdf(content: string, outputPath: string, title?: string): Promise<void> {
    // For CLI simplicity, generate a print-ready HTML that can be converted to PDF
    // Users can open in browser and print to PDF, or we provide instructions
    const htmlPath = outputPath.replace(/\.pdf$/, '.print.html');

    const htmlContent = await marked.parse(content);
    const printHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${title || 'Research Report'}</title>
    <style>
        @page { margin: 1in; }
        @media print {
            body { font-size: 11pt; }
            h1 { page-break-after: avoid; }
            h2, h3 { page-break-after: avoid; }
            pre, blockquote { page-break-inside: avoid; }
        }
        body {
            font-family: 'Times New Roman', Times, serif;
            max-width: 100%;
            margin: 0;
            padding: 0;
            line-height: 1.6;
            color: #000;
        }
        h1, h2, h3 { color: #000; margin-top: 1.5em; }
        h1 { font-size: 1.8em; border-bottom: 2px solid #000; }
        h2 { font-size: 1.4em; border-bottom: 1px solid #ccc; }
        code { font-family: 'Courier New', monospace; background: #f5f5f5; padding: 2px 4px; }
        pre { background: #f5f5f5; padding: 1em; border: 1px solid #ddd; white-space: pre-wrap; }
        blockquote { margin-left: 1em; padding-left: 1em; border-left: 3px solid #666; color: #333; }
        a { color: #0066cc; text-decoration: none; }
        a::after { content: " (" attr(href) ")"; font-size: 0.8em; color: #666; }
    </style>
</head>
<body>
<h1>${title || 'Research Report'}</h1>
${htmlContent}
<script>
    // Auto-print dialog
    if (window.location.search.includes('print')) {
        window.print();
    }
</script>
</body>
</html>`;

    // Save as print-ready HTML
    await writeFile(htmlPath, printHtml, 'utf-8');

    // Also save a simple note file explaining how to get PDF
    const pdfNote = `PDF Export

Your report has been saved as a print-ready HTML file:
${htmlPath}

To create a PDF:
1. Open the HTML file in your web browser
2. Press Cmd+P (Mac) or Ctrl+P (Windows)
3. Select "Save as PDF" as the destination
4. Click Save

The HTML file is formatted for professional printing.
`;

    await writeFile(outputPath, pdfNote, 'utf-8');
}

/**
 * Interactive format selection choices
 */
export const formatChoices = [
    { name: 'Markdown (.md)  →  Source formatting preserved', value: 'markdown' as ExportFormat },
    { name: 'HTML (.html)    →  View in browser', value: 'html' as ExportFormat },
    { name: 'Word (.docx)    →  Edit in Word/Google Docs', value: 'docx' as ExportFormat },
    { name: 'Plain text (.txt) →  Simple text', value: 'txt' as ExportFormat },
    { name: 'PDF (.pdf)      →  Print-ready (via HTML)', value: 'pdf' as ExportFormat },
];
