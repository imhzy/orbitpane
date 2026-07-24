def test_partial():
    buffer = "这是一个测试<"
    lower_buf = buffer.lower()
    
    possible_partial = False
    for tag in ["<thought>", "<think>"]:
        for i in range(1, len(tag)):
            if lower_buf.endswith(tag[:i]):
                possible_partial = True
                print(f"Matched partial: {tag[:i]}")
                break
        if possible_partial:
            break
            
    print("Is partial?", possible_partial)

test_partial()
