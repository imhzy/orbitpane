buffer = "I am "
lower_buf = buffer.lower()
possible_partial = False
for tag in ["<thought>", "<think>"]:
    for i in range(1, len(tag)):
        if lower_buf.endswith(tag[:i]):
            possible_partial = True
            break
    if possible_partial:
        break
print(f"buffer: {buffer!r}, possible_partial: {possible_partial}")

buffer = "I am <t"
lower_buf = buffer.lower()
possible_partial = False
for tag in ["<thought>", "<think>"]:
    for i in range(1, len(tag)):
        if lower_buf.endswith(tag[:i]):
            possible_partial = True
            break
    if possible_partial:
        break
print(f"buffer: {buffer!r}, possible_partial: {possible_partial}")

buffer = "I am <thought>hello"
t_idx = buffer.lower().find("<thought>")
print(f"buffer: {buffer!r}, t_idx: {t_idx}")
