import React from "react";
import { Activity } from "lucide-react";

interface VisionReport {
  id: string;
  content: string;
  timestamp: number;
  priority: "high" | "medium" | "low";
  latency: number;
}

interface ReportsListProps {
  reports: VisionReport[];
}

const ReportsList: React.FC<ReportsListProps> = ({ reports }) => {
  const getPriorityColor = (priority: "high" | "medium" | "low") => {
    switch (priority) {
      case "high":
        return "bg-red-500/20 border-red-500/50 text-red-100";
      case "medium":
        return "bg-yellow-500/20 border-yellow-500/50 text-yellow-100";
      case "low":
        return "bg-blue-500/20 border-blue-500/50 text-blue-100";
    }
  };

  const getPriorityDot = (priority: "high" | "medium" | "low") => {
    switch (priority) {
      case "high":
        return "bg-red-400";
      case "medium":
        return "bg-yellow-400";
      case "low":
        return "bg-blue-400";
    }
  };

  const formatTimestamp = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 1000) return "now";
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    return `${Math.floor(diff / 60000)}m ago`;
  };

  return (
    <div className="absolute top-24 right-4 w-72 max-h-96 overflow-hidden z-10 pointer-events-none">
      <div className="bg-black/60 backdrop-blur-md rounded-lg border border-white/10 p-3">
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-white/10">
          <Activity className="w-4 h-4 text-white" />
          <span className="text-white text-xs font-medium">Vision Reports</span>
          <span className="text-white/50 text-xs ml-auto">
            {reports.length}
          </span>
        </div>

        <div className="space-y-2 max-h-80 overflow-y-auto">
          {reports.slice(0, 8).map((report) => (
            <div
              key={report.id}
              className={`border rounded-lg p-2 ${getPriorityColor(report.priority)}`}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${getPriorityDot(report.priority)}`}
                  />
                  <span className="text-[10px] font-medium uppercase opacity-70">
                    {report.priority}
                  </span>
                </div>
                <span className="text-[10px] opacity-70">
                  {formatTimestamp(report.timestamp)}
                </span>
              </div>

              <p className="text-xs leading-snug">{report.content}</p>

              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-current/20">
                <span className="text-[10px] opacity-60">
                  Latency: {report.latency}ms
                </span>
              </div>
            </div>
          ))}

          {reports.length === 0 && (
            <div className="text-center text-white/40 text-xs py-4">
              Waiting for reports...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReportsList;
