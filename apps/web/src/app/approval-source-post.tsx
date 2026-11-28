import { ExternalLink } from '@/components/external-link';

export type ApprovalPost = {
  channel: string;
  author: string | null;
  href: string | null;
  text: string;
};

export function ApprovalSourcePost({ post }: { post: ApprovalPost | null }) {
  if (!post) return null;
  return (
    <div className="approval-source-post">
      <div className="approvals-proposal-context">
        {post.href ? (
          <ExternalLink href={post.href}>View original post on {post.channel}</ExternalLink>
        ) : (
          <span>Original {post.channel} post</span>
        )}
        {post.author && <span>{post.author}</span>}
      </div>
      {post.text && <blockquote className="approvals-preview">{post.text}</blockquote>}
    </div>
  );
}
