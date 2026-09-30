import { IsArray, IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Priority, TaskStatus } from '@prisma/client';
export class TaskDto { @IsString() title!: string; @IsOptional() @IsString() description?: string; @IsString() assignedToId!: string; @IsOptional() @IsArray() @IsString({ each: true }) participantIds?: string[]; @IsEnum(Priority) priority!: Priority; @IsString() category!: string; @IsDateString() dueDate!: string; @IsOptional() @IsString() dueTime?: string; }
export class UpdateTaskDto extends TaskDto { @IsEnum(TaskStatus) status!: TaskStatus; }
export class TaskStatusDto { @IsEnum(TaskStatus) status!: TaskStatus; }
export class TaskCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;
}
