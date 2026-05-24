"""
快速排序 (Quick Sort)
时间复杂度: 平均 O(n log n)，最坏 O(n²)
空间复杂度: O(log n)
"""

def quick_sort(arr):
    """快速排序函数"""
    if len(arr) <= 1:
        return arr
    
    # 选择基准元素（这里取中间元素）
    pivot = arr[len(arr) // 2]
    
    # 分区
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    
    # 递归排序并合并
    return quick_sort(left) + middle + quick_sort(right)


# 原地排序版本（节省内存）
def quick_sort_inplace(arr, low=0, high=None):
    """原地快速排序，直接修改原数组"""
    if high is None:
        high = len(arr) - 1
    
    if low < high:
        # 分区，获取基准位置
        pi = partition(arr, low, high)
        # 递归排序左右两部分
        quick_sort_inplace(arr, low, pi - 1)
        quick_sort_inplace(arr, pi + 1, high)
    
    return arr


def partition(arr, low, high):
    """分区函数：将小于基准的元素放左边，大于的放右边"""
    pivot = arr[high]  # 选最后一个元素为基准
    i = low - 1
    
    for j in range(low, high):
        if arr[j] <= pivot:
            i += 1
            arr[i], arr[j] = arr[j], arr[i]
    
    arr[i + 1], arr[high] = arr[high], arr[i + 1]
    return i + 1


# 测试示例
if __name__ == "__main__":
    test_arr = [3, 6, 8, 10, 1, 2, 1]
    print(f"原始数组: {test_arr}")
    print(f"排序结果: {quick_sort(test_arr.copy())}")
    
    arr_inplace = [3, 6, 8, 10, 1, 2, 1]
    quick_sort_inplace(arr_inplace)
    print(f"原地排序: {arr_inplace}")
