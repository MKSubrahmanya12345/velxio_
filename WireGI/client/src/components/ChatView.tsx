import type { Project } from '../types';

export default function ChatView({ project }: { project: Project }) {
  return (
    <div className="chat">
      {project.state.chat.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          <pre>{m.content}</pre>
        </div>
      ))}
    </div>
  );
}
