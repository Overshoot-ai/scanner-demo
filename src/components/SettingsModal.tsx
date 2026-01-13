import React, { useState } from "react";
import { X, Key, Save } from "lucide-react";

interface SettingsModalProps {
  initialKeys: {
    overshoot: string;
    openai: string;
  };
  onSave: (keys: { overshoot: string; openai: string }) => void;
  onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({
  initialKeys,
  onSave,
  onClose,
}) => {
  const [overshootKey, setOvershootKey] = useState(initialKeys.overshoot);
  const [openaiKey, setOpenaiKey] = useState(initialKeys.openai);

  const handleSave = () => {
    if (!overshootKey || !openaiKey) {
      alert("Please fill in all API keys");
      return;
    }

    onSave({
      overshoot: overshootKey,
      openai: openaiKey,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 p-6 text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Key className="w-6 h-6" />
              <h2 className="text-xl font-bold">API Configuration</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-white/20 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-white/80 mt-2">
            Configure your API keys to enable real-time narration
          </p>
        </div>

        {/* Form */}
        <div className="p-6 space-y-5">
          {/* Overshoot API Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Overshoot API Key
            </label>
            <input
              type="password"
              value={overshootKey}
              onChange={(e) => setOvershootKey(e.target.value)}
              placeholder="os_..."
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
            />
            <p className="text-xs text-gray-500 mt-1">
              Get your key at{" "}
              <a
                href="https://overshoot.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                overshoot.ai
              </a>
            </p>
          </div>

          {/* OpenAI API Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              OpenAI API Key
            </label>
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-proj-..."
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
            />
            <p className="text-xs text-gray-500 mt-1">
              For narration (LLM + TTS combined). Get it at{" "}
              <a
                href="https://platform.openai.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                platform.openai.com
              </a>
            </p>
          </div>

          {/* Info Box */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-xs text-blue-800 leading-relaxed">
              <strong>Privacy:</strong> Your API keys are stored locally in your
              browser and never sent to any third-party servers except the
              respective API providers.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="p-6 pt-0 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 border border-gray-300 rounded-lg font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-lg font-medium hover:from-blue-700 hover:to-purple-700 transition-all flex items-center justify-center gap-2"
          >
            <Save className="w-4 h-4" />
            Save Keys
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
