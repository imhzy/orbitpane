def fibonacci_up_to(limit):
    numbers = []
    a, b = 0, 1

    while a <= limit:
        numbers.append(a)
        a, b = b, a + b

    return numbers


if __name__ == "__main__":
    for number in fibonacci_up_to(100):
        print(number)
