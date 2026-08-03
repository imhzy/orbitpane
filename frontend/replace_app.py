import re

with open('/root/agy_web_bridge/frontend/src/App.tsx', 'r') as f:
    content = f.read()

# 1. Add imports
imports = """import { ChatHeader } from './components/ChatHeader'
import { ChatInput } from './components/ChatInput'
import { WelcomeScreen } from './components/WelcomeScreen'
import { MessageList } from './components/MessageList'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
"""
content = re.sub(r"import \{ ThinkingBlock \} from '\./components/ThinkingBlock'", imports + "\nimport { ThinkingBlock } from './components/ThinkingBlock'", content, count=1)

# 2. Remove unused icons
# The TS errors showed unused icons in lucide-react import
# Let's just remove all unused icons: Compass, FolderPlus, Sun, Moon, Check, ChevronDown, Sparkles, Copy, Layers, HardDrive, Eraser, Pencil, User, RotateCcw, ThumbsUp, ThumbsDown, AlertCircle, Square, RefreshCw, FolderGit2, Cpu, Download
unused_icons = ['Compass', 'FolderPlus', 'Sun', 'Moon', 'Check', 'ChevronDown', 'Sparkles', 'Copy', 'Layers', 'HardDrive', 'Eraser', 'Pencil', 'User', 'RotateCcw', 'ThumbsUp', 'ThumbsDown', 'AlertCircle', 'Square', 'RefreshCw', 'FolderGit2', 'Cpu', 'Download']
for icon in unused_icons:
    content = re.sub(r'\b' + icon + r'\b\s*,?\s*', '', content)

# Remove empty lines in imports
content = re.sub(r'import\s*\{\s*\}\s*from\s*\'lucide-react\'', '', content)

# Also LogoIcon, ThinkingBlock are not used in App.tsx anymore!
content = re.sub(r"import \{ LogoIcon \} from '\./LogoIcon'\n", "", content)
content = re.sub(r"import \{ ThinkingBlock \} from '\./components/ThinkingBlock'\n", "", content)
content = re.sub(r"const MarkdownContent = lazy\(\(\) => import\('\./components/MarkdownContent'\)\)\n", "", content)

# 3. Remove ModelSelector entirely
content = re.sub(r'interface ModelSelectorProps \{.*?\}\n\nfunction ModelSelector.*?\}\n\n', '', content, flags=re.DOTALL)

# 4. Replace Sidebar
sidebar_start = r'\{\/\* Sidebar Drawer \*\/\}.*?\{\/\* Main Chat Area \*\/\}'
sidebar_code = """      {/* Sidebar Drawer */}
      <Sidebar
        isDrawerOpen={isDrawerOpen}
        setIsDrawerOpen={setIsDrawerOpen}
        drawerMode={drawerMode}
        setDrawerMode={setDrawerMode}
        conversations={conversations}
        isConversationsLoading={isConversationsLoading}
        activeConv={activeConv}
        selectConversation={selectConversation}
        editingConvId={editingConvId}
        editingConvName={editingConvName}
        setEditingConvName={setEditingConvName}
        saveConvName={saveConvName}
        startEditingConv={startEditingConv}
        deleteConversation={deleteConversation}
        getProviderBadge={getProviderBadge}
        providers={providers}
        newConvName={newConvName}
        setNewConvName={setNewConvName}
        selectedDir={selectedDir}
        setSelectedDir={setSelectedDir}
        currentPath={currentPath}
        setCurrentPath={setCurrentPath}
        selectedProvider={selectedProvider}
        setSelectedProvider={setSelectedProvider}
        defaultProvider={defaultProvider}
        items={items}
        loadDir={loadDir}
        getBreadcrumbParts={getBreadcrumbParts}
        createConversation={createConversation}
        loadConversations={loadConversations}
        showToast={showToast}
      />

      {/* Main Chat Area */}"""
content = re.sub(sidebar_start, sidebar_code, content, flags=re.DOTALL)

# 5. Replace ChatHeader
header_start = r'<div className="chat-header">.*?</div>\n\n        <div\n          className="chat-messages"'
header_code = """<ChatHeader
          activeConv={activeConv}
          editingConvId={editingConvId}
          editingConvName={editingConvName}
          setEditingConvName={setEditingConvName}
          saveConvName={saveConvName}
          startEditingConv={startEditingConv}
          getProviderBadge={getProviderBadge}
          providers={providers}
          isDrawerOpen={isDrawerOpen}
          setIsDrawerOpen={setIsDrawerOpen}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          models={models}
          formatModelName={formatModelName}
          loadModels={loadModels}
          theme={theme}
          toggleTheme={toggleTheme}
          isConnected={isConnected}
          isReconnecting={isReconnecting}
          connectWebSocket={connectWebSocket}
          activeConvRef={activeConvRef}
          isExporting={isExporting}
          exportConversationAsImage={exportConversationAsImage}
          messages={messages}
          clearMessages={clearMessages}
        />

        <div
          className="chat-messages" """
content = re.sub(header_start, header_code, content, flags=re.DOTALL)

# 6. WelcomeScreen and MessageList
content = re.sub(r'\{\!activeConv && \(\n              <motion\.div.*?\}\n\n            \{activeConv && messages\.filter\(m => m\.role !== \'system\'\)\.length === 0 && \(.*?</motion\.div>\n          \)\}', '<WelcomeScreen activeConv={activeConv} messages={messages} setIsDrawerOpen={setIsDrawerOpen} />', content, flags=re.DOTALL)

message_list_code = """<MessageList
            messages={messages}
            copiedMsgIdx={copiedMsgIdx}
            feedbackState={feedbackState}
            isAgentThinking={isAgentThinking}
            copyMessageText={copyMessageText}
            handleFeedback={handleFeedback}
            regenerateLastResponse={regenerateLastResponse}
            formatModelName={formatModelName}
            formatTimestamp={formatTimestamp}
            messagesEndRef={messagesEndRef}
          />"""
content = re.sub(r'\{messages\.map\(\(m, i\) => \{.*?<div ref=\{messagesEndRef\} />', message_list_code, content, flags=re.DOTALL)

# 7. Replace ChatInput
input_code = """<ChatInput
          activeConv={activeConv}
          input={input}
          handleInput={handleInput}
          handleKeyDown={handleKeyDown}
          sendMessage={sendMessage}
          isAgentThinking={isAgentThinking}
          isConnected={isConnected}
          textareaRef={textareaRef}
          isNearBottom={isNearBottom}
          scrollToBottom={scrollToBottom}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          models={models}
          formatModelName={formatModelName}
          loadModels={loadModels}
          socketRef={socketRef}
          connectWebSocket={connectWebSocket}
          showToast={showToast}
          setIsDrawerOpen={setIsDrawerOpen}
        />"""
content = re.sub(r'<div className="input-area">.*?</div>\n        </div>\n      </div>', input_code + '\n      </div>', content, flags=re.DOTALL)


# 8. Replace Toast
toast_code = "      <Toast toast={toast} />"
content = re.sub(r'\{\/\* Toast Notification \*\/\}\n      <AnimatePresence>.*?</AnimatePresence>', '{/* Toast Notification */}\n' + toast_code, content, flags=re.DOTALL)


with open('/root/agy_web_bridge/frontend/src/App.tsx', 'w') as f:
    f.write(content)

