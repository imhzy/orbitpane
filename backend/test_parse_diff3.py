import asyncio
import codecs

async def test_parse():
    class MockManager:
        async def broadcast(self, conv_id, msg):
            pass #print("BROADCAST:", repr(msg['content']))
            
    manager = MockManager()
    conv_id = 1
    
    # Simulate a chunk that ends with '<' inside the diff
    raw_text = """```diff
diff --git a/test_sub_get_speed.py b/test_sub_get_speed.py
index a3e66c5..8ff575b 100644
--- a/test_sub_get_speed.py
+++ b/test_sub_get_speed.py
@@ -14,6 +14,8 @@ lock = threading.Lock()
 
 total_sub_wins = 0
 total_poll_wins = 0
+total_sub_lead_time_sum = 0.0
+total_poll_lead_time_sum = 0.0
 last_processed_timetags = set()
 
 def on_tick(data):
@@ -55,30 +57,42 @@ def poll_thread():
         time.sleep(POLL_INTERVAL)
 
 def report_thread():
-    global total_sub_wins, total_poll_wins, last_processed_timetags
+    global total_sub_wins, total_poll_wins, total_sub_lead_time_sum, total_poll_lead_time_sum, last_processed_timetags
     for i in range(1, 11):
         # 等待 1 分钟
         time.sleep(REPORT_INTERVAL)
         
         minute_sub_wins = 0
         minute_poll_wins = 0
+        minute_sub_lead_time_sum = 0.0
+        minute_poll_lead_time_sum = 0.0
         
         with lock:
             for timetag, times in seen_times.items():
                 if timetag not in last_processed_timetags:
                     # 只有两个方法都获取到了，才进行对比
                     if 'sub' in times and 'poll' in times:
-                        if times['sub'] < times['poll']:
+                        diff = times['poll'] - times['sub']
+                        if diff > 0:
                             minute_sub_wins += 1
                             total_sub_wins += 1
-                        elif times['poll'] < times['sub']:
+                            minute_sub_lead_time_sum += diff
+                            total_sub_lead_time_sum += diff
+                        elif diff < 0:
                             minute_poll_wins += 1
                             total_poll_wins += 1
+                            minute_poll_lead_time_sum += abs(diff)
+                            total_poll_lead_time_sum += abs(diff)
                         last_processed_timetags.add(timetag)
                         
+        avg_sub_lead = (minute_sub_lead_time_sum / minute_sub_wins * 1000) if minute_sub_wins > 0 else 0
+        avg_poll_lead = (minute_poll_lead_time_sum / minute_poll_wins * 1000) if minute_poll_wins > 0 else 0
+        total_avg_sub_lead = (total_sub_lead_time_sum / total_sub_wins * 1000) if total_sub_wins > 0 else 0
+        total_avg_poll_lead = (total_poll_lead_time_sum / total_poll_wins * 1000) if total_poll_wins > 0 else 0
+                        
         msg = f"【行情速度对比 - {CODE}】 第 {i}/10 分钟:\n" \
-              f"本分钟新增 -> 订阅快: {minute_sub_wins} 次, 轮询快: {minute_poll_wins} 次\n" \
-              f"累计总计 -> 订阅快: {total_sub_wins} 次, 轮询快: {total_poll_wins} 次"
+              f"本分钟新增 -> 订阅快: {minute_sub_wins} 次 (平均快 {avg_sub_lead:.2f} ms), 轮询快: {minute_poll_wins} 次 (平均快 {avg_poll_lead:.2f} ms)\n" \
+              f"累计总计 -> 订阅快: {total_sub_wins} 次 (平均快 {total_avg_sub_lead:.2f} ms), 轮询快: {total_poll_wins} 次 (平均快 {total_avg_poll_lead:.2f} ms)"
         print(msg)
         try:
             reportNormal(msg)
@@ -113,7 +127,9 @@ if __name__ == '__main__':
     # 测试结束，清理订阅
     xtdata.unsubscribe_quote(sub_id)
     
-    msg_end = f"【行情速度对比 - {CODE}】 测试结束！\n最终结果 -> 订阅赢: {total_sub_wins} 次, 轮询赢: {total_poll_wins} 次"
+    total_avg_sub_lead = (total_sub_lead_time_sum / total_sub_wins * 1000) if total_sub_wins > 0 else 0
+    total_avg_poll_lead = (total_poll_lead_time_sum / total_poll_wins * 1000) if total_poll_wins > 0 else 0
+    msg_end = f"【行情速度对比 - {CODE}】 测试结束！\n最终结果 -> 订阅赢: {total_sub_wins} 次 (平均快 {total_avg_sub_lead:.2f} ms), 轮询赢: {total_poll_wins} 次 (平均快 {total_avg_poll_lead:.2f} ms)"
     print(msg_end)
     try:
         reportNormal(msg_end)
```"""
    
    response_content = ""
    in_thought = False
    buffer = ""
    
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    
    chunk_size = 512
    raw_bytes = raw_text.encode('utf-8')
    
    i = 0
    while i < len(raw_bytes):
        chunk_bytes = raw_bytes[i:i+chunk_size]
        chunk = decoder.decode(chunk_bytes, final=False)
        buffer += chunk
        
        while buffer:
            lower_buf = buffer.lower()
            if not in_thought:
                t_idx = lower_buf.find("<thought>")
                tk_idx = lower_buf.find("<think>")
                
                if t_idx != -1 or tk_idx != -1:
                    pass
                else:
                    possible_partial = False
                    for tag in ["<thought>", "<think>"]:
                        for j in range(1, len(tag)):
                            if lower_buf.endswith(tag[:j]):
                                possible_partial = True
                                break
                        if possible_partial:
                            break
                    
                    if possible_partial:
                        # Find the point where partial matched!
                        # e.g., buffer ends with "<th"
                        matched_part = None
                        for tag in ["<thought>", "<think>"]:
                            for j in range(1, len(tag)):
                                if lower_buf.endswith(tag[:j]):
                                    matched_part = tag[:j]
                                    break
                            if matched_part:
                                break
                        print("Partial matched on:", repr(matched_part), "buffer end:", repr(buffer[-10:]))
                        break
                    else:
                        await manager.broadcast(conv_id, {"type": "token", "content": buffer})
                        response_content += buffer
                        buffer = ""
        i += chunk_size

asyncio.run(test_parse())
