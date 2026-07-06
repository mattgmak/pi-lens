import type { FactProvider } from "../fact-provider-types.js";
import { parseFactTree, walk } from "./tree-sitter-facts.js";

export interface CommentSummary {
  line: number;
  text: string;
}

export const commentFactProvider: FactProvider = {
  id: "fact.file.comments",
  provides: ["file.comments"],
  requires: ["file.content"],
  appliesTo(ctx) {
    return /\.tsx?$/.test(ctx.filePath);
  },
  async run(ctx, store) {
    const content = store.getFileFact<string>(ctx.filePath, "file.content");
    if (!content) {
      store.setFileFact(ctx.filePath, "file.comments", []);
      return;
    }

    const root = await parseFactTree(ctx.filePath, content);
    if (!root) {
      store.setFileFact(ctx.filePath, "file.comments", []);
      return;
    }

    // Tree-sitter attaches comments as `comment` nodes wherever they occur; a
    // pre-order walk yields them in source order (matching the old scanner pass).
    const comments: CommentSummary[] = [];
    walk(root, (node) => {
      if (node.type === "comment") {
        comments.push({
          line: node.startPosition.row + 1,
          text: node.text,
        });
      }
    });

    store.setFileFact(ctx.filePath, "file.comments", comments);
  },
};
