import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import { AsyncApiPub, AsyncApiService, AsyncApiSub } from 'nestjs-asyncapi'
import { Server, Socket } from 'socket.io'
import { chatEvent } from 'configs/chat-event.constants'
import { ChatMessageDto } from 'dto/chatMessage.dto'
import { UserInRoomDto } from 'dto/userInRoom.dto'
import { ChatCreateRoomDto } from 'dto/chatCreateRoom.dto'
import { ChatJoinRoomDto } from 'dto/chatJoinRoom.dto'
import { ChatRoomDto } from 'dto/chatRoom.dto'
import { ChatService } from './chat.service'
import * as jwt from 'jsonwebtoken'
import { jwtConstants } from 'configs/jwt-token.config'
import { ChatRoom } from './chatroom.entity'
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UsePipes,
} from '@nestjs/common'
import { WSValidationPipe } from 'utils/WSValidationPipe'
import { Status } from 'user/status.enum'
import { ChatInviteDto } from 'dto/chatInvite.dto'
import { ChatPasswordDto } from 'dto/chatRoomPassword.dto'
import { RoomPasswordCommand } from './roomPasswordCommand.enum'
import { ChatInviteDMDto } from 'dto/chatInviteDM.dto'
import { RoomType } from './roomtype.enum'
import { ChatMuteUserDto } from 'dto/chatMuteUser.dto'
import { ChatUserEvent } from './chatuserEvent.enum'
import { ChatUserStatusChangedDto } from 'dto/chatuserStatusChanged.dto'
import { ChatBanUserDto } from 'dto/chatBanUser.dto'
import { UserStatusDto } from 'dto/userStatus.dto'

/* FIXME: websocket 테스트 클라이언트에서는 cors: true 키만 있어야 동작함
추후 제출 시에는 다음과 같이 변경:
@WebSocketGateway({ namespace: 'api/chat', transports: ['websocket'] })
*/
@Injectable()
@AsyncApiService()
@UsePipes(new WSValidationPipe())
@WebSocketGateway({ namespace: 'api/chat', transports: ['websocket'] })
export class ChatGateway {
  constructor(private readonly chatService: ChatService) {}
  @WebSocketServer()
  server: Server

  async handleConnection(client: Socket) {
    const { token } = client.handshake.auth
    try {
      const decoded = jwt.verify(
        token.trim(),
        jwtConstants.secret,
      ) as jwt.JwtPayload
      if (decoded.uidType !== 'user' || decoded.twoFactorPassed !== true) {
        return client.disconnect()
      }
      client.data.uid = decoded.uid
    } catch {
      return client.disconnect()
    }

    try {
      await this.chatService.changeStatus(client.data.uid, Status.ONLINE)
    } catch (error) {
      return error
    }
    try {
      const rooms = await this.chatService.findRoomsByUserId(client.data.uid)
      rooms.forEach((el) => {
        client.join(el.id.toString())
        console.log(`${client.data.uid} was joined to ${el.id}`)
      })
    } catch (error) {
      return error
    }
    console.log(`chat: uid ${client.data.uid} connected.`)
    this.onUserStatusChanged(client.data.uid)
  }

  async handleDisconnect(client: Socket) {
    // 현재 uid로 아직 연결된 소켓이 있으면 상태update 하지 않음
    const sockets = await this.chatService.getSocketByUid(
      this.server,
      client.data.uid,
    )
    if (sockets.length > 0) {
      console.log(`chat: uid ${client.data.uid} disconnected`)
      return
    }
    try {
      await this.chatService.changeStatus(client.data.uid, Status.OFFLINE)
    } catch (error) {
      return error
    }
    console.log(`chat: uid ${client.data.uid} disconnected and OFFLINE`)
    this.onUserStatusChanged(client.data.uid)
  }

  @AsyncApiSub({
    channel: chatEvent.STATUS,
    summary: '온,오프라인,게임중 상태변경',
    message: { name: 'uid, status', payload: { type: UserStatusDto } },
  })
  async onUserStatusChanged(uid: number) {
    const status = await this.chatService.getUserStatus(uid)
    this.server.emit(chatEvent.STATUS, { uid, status })
  }

  @AsyncApiPub({
    channel: chatEvent.SEND,
    summary: '클라이언트->서버로 메시지 전송',
    message: { name: 'ChatMessageDto', payload: { type: ChatMessageDto } },
  })
  @SubscribeMessage(chatEvent.SEND)
  async onSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChatMessageDto,
  ) {
    const { roomId, msgContent } = data
    const dmroom = await this.chatService.getDmRoomByRoomId(roomId)
    if (dmroom) {
      // roomId 의 roomtype이 DM이면 구성원 force join
      for (const uid of dmroom.dmParticipantsUid) {
        const sockets = await this.chatService.getSocketByUid(this.server, uid)
        for (const soc of sockets) {
          try {
            await this.chatService.addUserToRoom(uid, roomId)
          } catch (error) {}
          soc.join(roomId.toString())
        }
        this.emitNotice(uid, roomId, 'join')
      }
    }
    let isMuted: boolean
    try {
      isMuted = await this.chatService.isMuted(client.data.uid, roomId)
    } catch (error) {
      return error
    }
    if (!isMuted) {
      console.log(`chat: ${client.data.uid} sent ${msgContent}`)
      this.broadcastMessage(client, data)
    } else {
      console.log(
        `chat: ${client.data.uid} sent message but is muted in ${roomId}`,
      )
    }
    return { status: 200 }
  }

  @AsyncApiSub({
    channel: chatEvent.RECEIVE,
    summary: '다른 사용자의 메시지를 서버->클라이언트로 전송',
    message: { name: 'ChatMessageDto', payload: { type: ChatMessageDto } },
  })
  async broadcastMessage(client, data: ChatMessageDto) {
    data.senderUid = client.data.uid
    data.createdAt ??= new Date()
    // sender를 블록하지 않은 모든 사람에게 전송 (sender자신 포함)
    const sockets = await this.server.in(data.roomId.toString()).fetchSockets()
    const excludeList = await this.chatService.findBlockedMeUsers(
      data.senderUid,
    )
    sockets.forEach((soc) => {
      const participant = soc.data.uid
      // if (participant === data.senderUid) return
      if (excludeList.includes(participant)) return
      soc.emit(chatEvent.RECEIVE, data)
    })
  }

  @AsyncApiPub({
    channel: chatEvent.JOIN,
    summary: '채팅방에 참가',
    description: 'user가 채팅방에 새로 입장. 알림메시지를 모든 구성원에게 전송',
    message: { name: 'ChatJoinRoomDto', payload: { type: ChatJoinRoomDto } },
  })
  @SubscribeMessage(chatEvent.JOIN)
  async onJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() room: ChatJoinRoomDto,
  ) {
    try {
      await this.chatService.addUserToRoom(
        client.data.uid,
        room.roomId,
        room.password,
      )
    } catch (error) {
      return error
    }
    //client.join(room.roomId.toString())
    const sockets = await this.chatService.getSocketByUid(
      this.server,
      client.data.uid,
    )
    sockets.forEach(async (el) => {
      el.join(room.roomId.toString())
      this.emitNotice(client.data.uid, room.roomId, 'join')
    })
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.LEAVE,
    summary: '채팅방에서 나가기',
    description: 'user가 채팅방에서 나감. 알림메시지를 모든 구성원에게 전송',
    message: { name: 'ChatJoinRoomDto', payload: { type: ChatJoinRoomDto } },
  })
  @SubscribeMessage(chatEvent.LEAVE)
  async onLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() room: ChatJoinRoomDto,
  ) {
    const { roomId } = room
    try {
      // owner가 나가면 모두에게 DESTROYED 전송. 이후 모두 내보내고 채팅방 삭제
      if (await this.chatService.isOwner(client.data.uid, roomId)) {
        console.log(`chat: owner ${client.data.uid} leaved ${roomId}`)
        this.emitDestroyed(client, roomId)
        return { status: 200 }
      }
    } catch (error) {
      return error
    }

    try {
      await this.chatService.removeUserFromRoom(client.data.uid, roomId)
    } catch (error) {
      return error
    }
    client.leave(roomId.toString())
    console.log(`chat: ${client.data.uid} leaved ${roomId}`)
    this.emitNotice(client.data.uid, roomId, 'leave')
    return { status: 200 }
  }

  @AsyncApiSub({
    channel: chatEvent.DESTROYED,
    summary: '채팅방 삭제됨',
    description: 'owner가 채팅방을 나갔을 때, 모든 참여자에게 이벤트 전달',
    message: { payload: { type: UserInRoomDto } },
  })
  async emitDestroyed(
    @ConnectedSocket() client: Socket,
    @MessageBody() roomId: number,
  ) {
    const data: UserInRoomDto = { roomId: roomId, uid: client.data.uid }
    // 이벤트 전달
    this.server.to(roomId.toString()).emit(chatEvent.DESTROYED, data)
    // room 삭제
    this.server.in(roomId.toString()).socketsLeave(roomId.toString())
    // DB 삭제
    try {
      await this.chatService.deleteChatroom(client.data.uid, roomId)
    } catch (error) {
      return error
    }
  }

  @AsyncApiSub({
    channel: chatEvent.NOTICE,
    summary: '공지msg',
    description:
      "user 입장시 mscContent='join', 퇴장시 'leave'\n\n'banned'일 때 senderUid=밴된 당사자의 uid",
    message: { name: 'ChatMessageDto', payload: { type: ChatMessageDto } },
  })
  async emitNotice(uid: number, roomId: number, msg: string) {
    const data: ChatMessageDto = {
      roomId: roomId,
      senderUid: uid,
      msgContent: msg,
      createdAt: new Date(),
    }
    console.log(`chat: ${uid} has entered to ${roomId}`)
    this.server.to(roomId.toString()).emit(chatEvent.NOTICE, data)
  }

  @AsyncApiPub({
    channel: chatEvent.CREATE,
    summary: '새로운 채팅방 생성',
    description: 'DM type은 CREATE로 만들 수 없고, INVITE_DM을 써야 함',
    message: {
      name: 'ChatCreateRoomDto',
      payload: { type: ChatCreateRoomDto },
    },
  })
  @SubscribeMessage(chatEvent.CREATE)
  async onCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChatCreateRoomDto,
  ) {
    if (data.type === RoomType.DM)
      return new BadRequestException('DM room should be created by INVITE_DM')
    let newRoom: ChatRoom
    try {
      newRoom = await this.chatService.createChatroom(
        client.data.uid,
        data.title,
        data.type,
        data.password,
      )
    } catch (error) {
      return error
    }
    // client.join(newRoom.id.toString())
    const sockets = await this.chatService.getSocketByUid(
      this.server,
      client.data.uid,
    )
    sockets.forEach(async (el) => {
      el.join(newRoom.id.toString())
      this.emitNotice(client.data.uid, newRoom.id, 'join')
    })
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.ADD_ADMIN,
    summary: 'uid를 roomId의 admin에 추가',
    description: '성공하면 모든 참여자에게 CHATUSER_STATUS 이벤트 전송',
    message: { name: 'data', payload: { type: UserInRoomDto } },
  })
  @SubscribeMessage(chatEvent.ADD_ADMIN)
  async onAddAdmin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UserInRoomDto,
  ) {
    const { roomId, uid } = data
    if ((await this.chatService.isAdmin(client.data.uid, roomId)) === false)
      return new ForbiddenException('You are not admin')
    try {
      await this.chatService.addUserAsAdmin(uid, roomId)
    } catch (error) {
      return error
    }
    this.onUserUpdateded(roomId, uid, ChatUserEvent.ADMIN_ADDED)
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.REMOVE_ADMIN,
    summary: 'uid를  roomId의 admin에서 삭제',
    description: '성공하면 모든 참여자에게 CHATUSER_STATUS 이벤트 전송',
    message: { name: 'data', payload: { type: UserInRoomDto } },
  })
  @SubscribeMessage(chatEvent.REMOVE_ADMIN)
  async onRemoveAdmin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UserInRoomDto,
  ) {
    const { roomId, uid } = data
    if ((await this.chatService.isAdmin(client.data.uid, roomId)) === false)
      return new ForbiddenException('You are not admin')
    try {
      await this.chatService.removeUserAsAdmin(uid, roomId)
    } catch (error) {
      return error
    }
    this.onUserUpdateded(roomId, uid, ChatUserEvent.ADMIN_REMOVED)
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.BAN,
    summary: 'uid를 roomId의 banned 리스트에 추가',
    description:
      'admin이 아니거나 owner를 밴할 땐 403 리턴, uid나 roomId가 유효하지 않으면 400리턴',
    message: { name: 'ChatBanUserDto', payload: { type: ChatBanUserDto } },
  })
  @SubscribeMessage(chatEvent.BAN)
  async onBanUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChatBanUserDto,
  ) {
    const { uid, roomId } = data
    // check if client is admin
    if ((await this.chatService.isAdmin(client.data.uid, roomId)) === false)
      return new ForbiddenException('You are not admin')
    // check if target is owner
    if ((await this.chatService.isOwner(uid, roomId)) === true)
      return new ForbiddenException('Owner cannot be banned')
    // add user to banned list
    try {
      await this.chatService.addBannedUser(uid, roomId)
    } catch (error) {
      return error
    }
    // 모든 참여자에게 uid가 ban 됐음을 notice
    const msg: ChatMessageDto = {
      roomId: roomId,
      senderUid: uid,
      msgContent: 'banned',
      createdAt: new Date(),
    }
    this.server.to(roomId.toString()).emit(chatEvent.NOTICE, msg)
    // let user out from room
    const sockets = await this.chatService.getSocketByUid(this.server, uid)
    sockets.forEach(async (el) => {
      console.log(`${el.data.uid} will be banned from ${roomId}`)
      // el.emit(chatEvent.NOTICE, msg)
      el.leave(roomId.toString())
    })
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.UNBAN,
    summary: 'uid를 roomId의 banned 리스트에서 삭제',
    description:
      'admin이 아닐 땐 403 리턴, uid나 roomId가 유효하지 않으면 400리턴',
    message: { name: 'ChatBanUserDto', payload: { type: ChatBanUserDto } },
  })
  @SubscribeMessage(chatEvent.UNBAN)
  async onUnbanUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UserInRoomDto,
  ) {
    const { uid, roomId } = data
    // check if client is admin
    if ((await this.chatService.isAdmin(client.data.uid, roomId)) === false)
      return new ForbiddenException('You are not admin')
    // delete user from banned list
    try {
      await this.chatService.deleteBannedUser(uid, roomId)
    } catch (error) {
      return error
    }
    console.log(`chat: ${uid} is unbanned from ${roomId}`)
    // 모든 참여자에게 uid가 unban 됐음을 notice
    const msg: ChatMessageDto = {
      roomId: roomId,
      senderUid: uid,
      msgContent: 'unbanned',
      createdAt: new Date(),
    }
    this.server.to(roomId.toString()).emit(chatEvent.NOTICE, msg)
    // unban될 사용자에게 unban됐음을 notice
    const sockets = await this.chatService.getSocketByUid(this.server, uid)
    sockets.forEach(async (el) => {
      el.emit(chatEvent.NOTICE, msg)
    })
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.MUTE,
    summary: 'uid를 muteSec초동안 mute시킴',
    description:
      'admin이 아닐 땐 403 리턴, uid가 보낸 메시지는 roomId내에서 muteSec초동안 아무에게도 전달되지 않음\n\n모든 참여자에게 CHATUSER_STATUS 이벤트 전송',
    message: { name: 'ChatMuteUserDto', payload: { type: ChatMuteUserDto } },
  })
  @SubscribeMessage(chatEvent.MUTE)
  async onMuteUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChatMuteUserDto,
  ) {
    const { roomId } = data
    const target = data.uid
    // check if client is admin
    if ((await this.chatService.isAdmin(client.data.uid, roomId)) === false)
      return new ForbiddenException('You are not admin')
    try {
      await this.chatService.addMuteUser(target, roomId)
    } catch (error) {
      return error
    }
    console.log(`${target} in is muted in ${roomId}`)
    this.onUserUpdateded(roomId, target, ChatUserEvent.MUTED)
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.UNMUTE,
    summary: 'uid의 mute 상태를 해제',
    description:
      'admin이 아닐 땐 403 리턴, uid가 보낸 메시지를 roomId의 모든 참여자가 수신할 수 있음\n\n모든 참여자에게 CHATUSER_STATUS 이벤트 전송',
    message: { name: 'ChatMuteUserDto', payload: { type: ChatMuteUserDto } },
  })
  @SubscribeMessage(chatEvent.UNMUTE)
  async onUnmuteUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChatMuteUserDto,
  ) {
    const roomId = data.roomId
    const target = data.uid
    // check if client is admin
    if ((await this.chatService.isAdmin(client.data.uid, roomId)) === false)
      return new ForbiddenException('You are not admin')
    try {
      await this.chatService.deleteMuteUser(target, roomId)
    } catch (error) {
      return error
    }
    console.log(`${target} in is unmuted in ${roomId}`)
    this.onUserUpdateded(roomId, target, ChatUserEvent.UNMUTED)
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.INVITE,
    summary: 'nickname을 roomID에 초대',
    description:
      'nickname이 존재하지 않으면 404 리턴, 접속중이 아니거나 이미 방에 속해있으면 400 리턴, 문제 없으면 200 리턴',
    message: { name: 'ChatInviteDto', payload: { type: ChatInviteDto } },
  })
  @SubscribeMessage(chatEvent.INVITE)
  async onInvite(
    @ConnectedSocket() client,
    @MessageBody() data: ChatInviteDto,
  ) {
    const inviter = client.data.uid
    const roomId = data.roomId
    const invitee = await this.chatService.findUidByNickname(
      data.inviteeNickname,
    )
    const isInvite = true
    // inviteeNickname이 존재하는지
    if (invitee === null) return new NotFoundException()
    // inviter가 roomId에 속해있는지
    if (client.rooms.has(roomId.toString()) === false)
      return new BadRequestException()
    // invitee가 roomId에 속해있는지
    if (await this.chatService.isUserInRoom(invitee, roomId))
      return new BadRequestException('user is already in room')
    // invitee의 소켓id 찾아서 room에 추가
    const sockets = await this.chatService.getSocketByUid(this.server, invitee)
    if (sockets.length === 0) {
      console.log(`${invitee} is not online`)
      return new BadRequestException('user is not online')
    }
    for (const soc of sockets) {
      try {
        await this.chatService.addUserToRoom(invitee, roomId, null, isInvite)
      } catch (error) {}
      soc.join(roomId.toString())
    }
    // room의 모두에게 NOTICE 전송
    this.emitNotice(invitee, roomId, 'join')
  }

  @AsyncApiPub({
    channel: chatEvent.INVITE_DM,
    summary: 'invitee와의 DM방 생성',
    description:
      'dm방을 새로 만들고 sender와 invitee를 집어넣음. sender와 invitee에게 "join"을 NOTICE\n\nsender와 invitee를 위한 DM방이 이미 존재하고, sender가 그 방에 들어있으면 400과 roomId를 리턴',
    message: { name: 'ChatInviteDMDto', payload: { type: ChatInviteDMDto } },
  })
  @SubscribeMessage(chatEvent.INVITE_DM)
  async onInviteDM(
    @ConnectedSocket() client,
    @MessageBody() data: ChatInviteDMDto,
  ) {
    const inviter = client.data.uid
    const { invitee } = data
    const title = `DM_with_${inviter}_and_${invitee}`

    // inviter, invitee 둘이 속한 DM방이 있는지 확인
    const room = await this.chatService.getRoomDmByUid(inviter, invitee)
    if (room) {
      if (await this.chatService.isUserInRoom(inviter, room.id)) {
        return {
          status: 400,
          roomId: room.id,
          message: `DM for ${inviter} and ${invitee} already exists(roomId ${room.id})`,
        }
      } else {
        const sockets = await this.chatService.getSocketByUid(
          this.server,
          inviter,
        )
        sockets.forEach(async (el) => {
          el.join(room.id.toString())
          this.emitNotice(inviter, room.id, 'join')
        })
        this.chatService.addUserToRoom(inviter, room.id)
        return { status: 200 }
      }
    }
    // create new DM room
    let newRoom: ChatRoom
    try {
      newRoom = await this.chatService.createDmRoom(inviter, invitee, title)
    } catch (error) {
      return error
    }
    client.join(newRoom.id.toString())

    const sockets = await this.chatService.getSocketByUid(this.server, invitee)
    sockets.forEach(async (el) => {
      el.join(newRoom.id.toString())
    })

    this.emitNotice(inviter, newRoom.id, 'join')
    this.emitNotice(invitee, newRoom.id, 'join')
    return { status: 200 }
  }

  @AsyncApiPub({
    channel: chatEvent.PASSWORD,
    summary: 'roomId의 password를 추가/변경/삭제',
    description: '추가하면 roomType이 PROTECTED로, 삭제하면 PUBLIC으로 바뀜',
    message: { name: 'chatPasswordDto', payload: { type: ChatPasswordDto } },
  })
  @SubscribeMessage(chatEvent.PASSWORD)
  async onPasswordCUD(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ChatPasswordDto,
  ) {
    try {
      const { uid } = client.data
      const { roomId, command, password } = data

      if (command === RoomPasswordCommand.ADD)
        this.chatService.createRoomPassword(uid, roomId, password)
      else if (command === RoomPasswordCommand.DELETE)
        this.chatService.deleteRoomPassword(uid, roomId)
      else if (command === RoomPasswordCommand.MODIFY)
        this.chatService.changeRoomPassword(uid, roomId, password)
    } catch (error) {
      return error
    }
    return { status: 200 }
  }

  @AsyncApiSub({
    channel: chatEvent.CHATUSER_STATUS,
    summary: 'room 참여자의 일부 상태 변경',
    description: 'mute, unmute, addAdmin, removeAdmin이 성공했을 때',
    message: {
      name: 'ChatUserStatusChanged',
      payload: { type: ChatUserStatusChangedDto },
    },
  })
  async onUserUpdateded(roomId: number, uid: number, eventType: ChatUserEvent) {
    const data: ChatUserStatusChangedDto = {
      roomId: roomId,
      uid: uid,
      type: eventType,
    }
    this.server.to(roomId.toString()).emit(chatEvent.CHATUSER_STATUS, data)
  }

  async gameEnded(uid: number) {
    const sockets = await this.chatService.getSocketByUid(this.server, uid)
    if (sockets.length > 0) {
      await this.chatService.changeStatus(uid, Status.ONLINE)
    } else {
      await this.chatService.changeStatus(uid, Status.OFFLINE)
    }
    this.onUserStatusChanged(uid)
  }
}
