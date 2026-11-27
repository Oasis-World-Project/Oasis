// 房间里的消息变了就叫醒它开着的推送：被叫马上回，没人叫到点回，连接断了抛错；不留等着的。
import { describe, expect, it } from 'vitest';
import { createRoomWake } from '../src/service/room-wake.ts';

describe('叫醒房间的推送', () => {
  it('这个房间变了：等着它的都马上回，别的房间的不动；没人叫就到点回', async () => {
    const rooms = createRoomWake();
    const never = new AbortController().signal;
    const began = Date.now();
    const mine = [rooms.wait('a', 5_000, never), rooms.wait('a', 5_000, never)];
    let other = false;
    const elsewhere = rooms.wait('b', 80, never).then(() => (other = true));
    rooms.wake('a');
    await Promise.all(mine);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(other).toBe(false);
    await elsewhere;
    expect(Date.now() - began).toBeGreaterThanOrEqual(70);
    // 没人等着时叫一声不出错，之后再等照常
    rooms.wake('a');
    await rooms.wait('a', 10, never);
  });

  it('连接断了：等着的抛错（和定时器被中止一样），推送循环就此收掉', async () => {
    const rooms = createRoomWake();
    const controller = new AbortController();
    const waiting = rooms.wait('a', 5_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
});
