
def gaps(n):
    """计算 1 到 n 中质数的间隔序列。n=7 → 质数 2,3,5,7 → [1,1,2]"""
    if n < 2:
        return []
    # 埃拉托斯特尼筛法
    is_prime = [True] * (n + 1)
    is_prime[0] = is_prime[1] = False
    for p in range(2, int(n ** 0.5) + 1):
        if is_prime[p]:
            for m in range(p * p, n + 1, p):
                is_prime[m] = False
    primes = [i for i in range(2, n + 1) if is_prime[i]]
    # 相邻质数之差
    return [primes[i] - primes[i - 1] for i in range(1, len(primes))]


# 验证示例
print("gaps(7)  =", gaps(7))        # 期望 [1,1,2]
print("gaps(100) =", gaps(100))
