import { IsArray, IsDateString, IsEnum, IsOptional, IsString } from 'class-validator'; import { Priority, ReminderRecurrence, ReminderStatus } from '@prisma/client';
export class ReminderDto { @IsString() title!: string; @IsOptional() @IsString() description?: string; @IsString() recipientId!: string; @IsOptional() @IsArray() @IsString({ each: true }) participantIds?: string[]; @IsEnum(Priority) priority!: Priority; @IsString() category!: string; @IsDateString() reminderDate!: string; @IsString() reminderTime!: string; @IsEnum(ReminderRecurrence) recurrence!: ReminderRecurrence; }
export class UpdateReminderDto extends ReminderDto { @IsEnum(ReminderStatus) status!: ReminderStatus; }
export class ReminderStatusDto { @IsEnum(ReminderStatus) status!: ReminderStatus; }
